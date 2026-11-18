#!/usr/bin/env python3
"""Exercise deployment and cleanup boundaries using local CLI fakes only."""
import json
import os
from pathlib import Path
import shutil
# Controlled unittest harness runs fixed scripts against fake CLIs.
import subprocess  # nosec B404
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
BASH = shutil.which("bash")
if BASH is None:
    raise RuntimeError("Bash is required for script tests")

FAKE_CLI = r'''
import json, os, sys
from pathlib import Path

tool = Path(sys.argv[0]).name
args = sys.argv[1:]
workspace = os.environ.get("TF_WORKSPACE", "default")
name = "" if workspace == "default" else workspace
prefix = "serverlessq" + ("-" + name if name else "")
storage = Path(os.environ["TRIVIA_TEST_DIR"])
call = {"tool": tool, "args": args, "workspace": workspace, "cwd": str(Path.cwd())}
if tool == "zip":
    call["files"] = {str(path): path.read_text() for path in [
        Path("package.json"), Path("package-lock.json"),
        Path("node_modules/@serverlessq/shared/package.json"),
        Path("node_modules/@serverlessq/shared/dist/index.js"), Path("dist/index.js")
    ] if path.exists()}
if tool == "npm" and args and args[0] in ["ci", "install"]:
    call.update({
        "manifest": Path("package.json").read_text(),
        "lock": Path("package-lock.json").read_text() if Path("package-lock.json").exists() else None,
        "shared_present": Path("node_modules/@serverlessq/shared").exists(),
    })
with (storage / "calls.jsonl").open("a") as log:
    log.write(json.dumps(call) + "\n")

def arg(key):
    return args[args.index(key) + 1]

if tool == "terraform":
    args = [a for a in args if not a.startswith("-chdir=")]
    if args[0] == "output":
        if (storage / (workspace + ".destroyed")).exists():
            print("{}")
        else:
            table_prefix = name + "-" if name else "dev-"
            values = {
                "primary_region": "us-east-1",
                "ddb_region": os.environ.get("TRIVIA_TEST_DDB_REGION", "us-east-1"),
                "cognito_region": os.environ.get("TRIVIA_TEST_COGNITO_REGION", "us-east-1"),
                "cognito_user_pool_id": "us-east-1_" + (name or "default"),
                "cognito_app_client_id": "client-" + (name or "default"),
                "regions": ["us-east-1", "us-west-2"],
                "code_bucket": prefix + "-web-code-123456789012",
                "api_execution_role_arn": "arn:aws:iam::123456789012:role/" + prefix + "-api-web-role",
                "web_execution_role_arn": "arn:aws:iam::123456789012:role/" + prefix + "-web-web-role",
                "table_names": {entity: table_prefix + "serverlessq-" + entity for entity in
                                ["question-sets", "questions", "games", "participants", "answers", "scores"]}
            }
            # The default fake deliberately represents state from before this change.
            if name:
                values.update(environment_name=name, api_function_name=prefix + "-api",
                              web_function_name=prefix + "-web", table_prefix=table_prefix)
            if os.environ.get("TRIVIA_TEST_WRONG_STATE"):
                values["environment_name"] = "demo2"
            if "-raw" in args:
                print(values[arg("-raw")], end="")
            else:
                print(json.dumps({key: {"value": value} for key, value in values.items()}))
    elif args[:2] == ["state", "list"]:
        if not (storage / (workspace + ".destroyed")).exists():
            print("aws_dynamodb_table.games\naws_s3_bucket.code")
    elif args[0] == "destroy":
        (storage / (workspace + ".destroyed")).touch()
    elif args[0] not in ["init", "apply"]:
        raise RuntimeError("unexpected Terraform command: " + str(args))
elif tool == "npm":
    if args[-2:] == ["run", "build"]:
        if os.environ.get("TRIVIA_TEST_BUILD_FAIL"):
            print("test compiler error")
            sys.exit(1)
        prefix_dir = Path(arg("--prefix"))
        build_dir = prefix_dir / "packages/shared" if "--workspace" in args else prefix_dir
        (build_dir / "dist").mkdir(parents=True, exist_ok=True)
        (build_dir / "dist/index.js").write_text("// explicit test build output\n")
    if args and args[0] == "install":
        print("deployment must use committed locks with npm ci", file=sys.stderr)
        sys.exit(1)
    if args and args[0] == "ci":
        if os.environ.get("TRIVIA_TEST_CI_FAIL"):
            print("test locked installation failed", file=sys.stderr)
            sys.exit(1)
        Path("node_modules").mkdir()
    if "pack" in args:
        print("shared.tgz")
elif tool == "zip":
    Path("function.zip").touch()
elif tool == "curl":
    function = args[-1].split("/")[2].removesuffix(".example.test")
    endpoint_path = storage / (function + ".endpoint.json")
    if endpoint_path.exists() and (json.loads(endpoint_path.read_text()).get("throttleConfig") or {}).get("rateLimit") == 0:
        print("HTTP 429: endpoint blocks all traffic", file=sys.stderr)
        sys.exit(22)
    if os.environ.get("TRIVIA_TEST_SMOKE_FAIL"):
        print("test smoke failed", file=sys.stderr)
        sys.exit(22)
    if args[-1].endswith("/config.json"):
        settings = json.loads((storage / (function + ".env.json")).read_text())
        api_url = "https://wrong-api.example.test" if os.environ.get("TRIVIA_TEST_BAD_WEB_CONFIG") else settings["API_BASE_URL"]
        print(json.dumps({"apiBaseUrl": api_url}))
    else:
        print('{"status":"ok"}')
elif tool == "aws":
    operation = args[:2]
    if operation == ["sts", "get-caller-identity"]:
        print(os.environ.get("TRIVIA_TEST_ACCOUNT", "123456789012"))
    elif operation == ["lambda-web", "wait"]:
        if (os.environ.get("TRIVIA_TEST_WAIT_FAIL") or
            (os.environ.get("TRIVIA_TEST_WAIT_FAIL_FUNCTION") == arg("--function-name") and
             os.environ.get("TRIVIA_TEST_WAIT_FAIL_KIND") == args[2] and
             (not os.environ.get("TRIVIA_TEST_WAIT_FAIL_REVISION") or
              ("--revision-id" in args and
               os.environ["TRIVIA_TEST_WAIT_FAIL_REVISION"] == arg("--revision-id"))))):
            print("Waiter failed", file=sys.stderr)
            sys.exit(1)
    elif operation == ["lambda-web", "help"]:
        pass
    elif operation == ["s3api", "put-object"]:
        print("test-version")
    elif operation == ["lambda-web", "get-web-function"]:
        if os.environ.get("TRIVIA_TEST_FUNCTION_LOOKUP_FAIL"):
            print("AccessDeniedException: cannot inspect function", file=sys.stderr)
            sys.exit(255)
        if not (storage / ("function." + arg("--function-name"))).exists():
            print("ResourceNotFoundException: function does not exist", file=sys.stderr)
            sys.exit(255)
    elif operation in [["lambda-web", "create-web-function"], ["lambda-web", "create-web-function-revision"]]:
        function = arg("--function-name")
        (storage / ("function." + function)).touch()
        initial = operation[1] == "create-web-function"
        revision = (json.loads(arg("--revision-config")) if initial else {
            "serviceConfig": json.loads(arg("--service-config")),
            "buildConfig": json.loads(arg("--build-config")),
        })
        service = revision["serviceConfig"]
        (storage / (function + ".env.json")).write_text(
            json.dumps(service["environmentVariables"]))
        revision_id = os.environ.get("TRIVIA_TEST_REVISION_ID", "revision-A" if initial else "revision-B")
        revision.update({
            "functionArn": "arn:aws:lambda:us-east-1:123456789012:web-function/" + function,
            "revisionArn": "arn:aws:lambda:us-east-1:123456789012:web-function/" + function + "/revision/" + revision_id,
            "revisionId": revision_id, "state": "Active", "stateReason": "The revision is active.",
            "createdAt": "2026-01-01T00:00:00Z",
        })
        (storage / (function + "." + revision_id + ".json")).write_text(json.dumps(revision))
        endpoint_path = storage / (function + ".endpoint.json")
        if initial:
            endpoint = json.loads(arg("--endpoint-config"))
            endpoint.update({
                "functionArn": revision["functionArn"],
                "endpointArn": revision["functionArn"] + "/endpoint/home",
                "domainName": function + ".example.test", "regions": ["us-east-1"],
                "revisionWeights": [{"revisionId": revision_id, "weight": 100}],
                "state": "Active", "stateReason": "The endpoint is active.",
                "createdAt": "2026-01-01T00:00:00Z", "updatedAt": "2026-01-01T00:00:00Z",
            })
        else:
            endpoint = json.loads(endpoint_path.read_text())
            if os.environ.get("TRIVIA_TEST_NO_UPDATE_STATUS"):
                endpoint.pop("updateStatus", None)
            else:
                endpoint["updateStatus"] = "Successful"
            if not os.environ.get("TRIVIA_TEST_HOME_STALE"):
                endpoint["revisionWeights"] = [{"revisionId": revision_id, "weight": 100}]
        endpoint["regionalEndpoints"] = {"us-east-1": {
            key: endpoint[key] for key in [
                "authType", "revisionWeights", "scalingConfig", "throttleConfig", "state", "stateReason"
            ] if key in endpoint
        }}
        patch = os.environ.get("TRIVIA_TEST_HOME_AFTER")
        if patch:
            endpoint.update(json.loads(patch))
        endpoint_path.write_text(json.dumps(endpoint))
        if "--query" in args:
            expected_query = "revision.revisionId" if initial else "revisionId"
            if arg("--query") != expected_query:
                raise RuntimeError("incorrect create revision ID query: " + arg("--query"))
            print(revision_id)
        else:
            print(json.dumps({"revision": revision, "endpoint": endpoint} if initial else revision))
    elif operation == ["lambda-web", "delete-web-function"]:
        (storage / ("function." + arg("--function-name"))).unlink(missing_ok=True)
    elif operation == ["lambda-web", "get-web-function-endpoint"]:
        if not (storage / ("function." + arg("--function-name"))).exists():
            print("ResourceNotFoundException: function does not exist", file=sys.stderr)
            sys.exit(255)
        endpoint = json.loads((storage / (arg("--function-name") + ".endpoint.json")).read_text())
        if "--query" in args:
            if arg("--query") != "domainName":
                raise RuntimeError("unexpected endpoint query: " + arg("--query"))
            print(endpoint["domainName"])
        else:
            print(json.dumps(endpoint))
    elif operation == ["lambda-web", "get-web-function-revision"]:
        revision = json.loads((storage / (arg("--function-name") + "." + arg("--revision-id") + ".json")).read_text())
        patch = os.environ.get("TRIVIA_TEST_REVISION_AFTER")
        if patch:
            revision.update(json.loads(patch))
        print(json.dumps(revision))
    elif operation == ["lambda-web", "update-web-function-endpoint"]:
        pass
    elif operation == ["dynamodb", "describe-table"]:
        # No tables anywhere in the fake account, worded like the real error.
        print("An error occurred (ResourceNotFoundException) when calling the DescribeTable operation", file=sys.stderr)
        sys.exit(1)
    elif operation in [["s3api", "head-bucket"], ["cognito-idp", "describe-user-pool"]]:
        sys.exit(1)
    elif operation == ["logs", "describe-log-groups"]:
        log_prefix = arg("--log-group-name-prefix")
        log_region = arg("--region")
        state_path = storage / ("logs-" + log_region + "-" + log_prefix.rsplit("/", 1)[-1] + ".json")
        if not state_path.exists():
            state_path.write_text(json.dumps([
                log_prefix,
                log_prefix + ".local",
                log_prefix + "/rev-1",
                log_prefix + "-foreign/rev-1",
                log_prefix + ".local-foreign",
            ]))
        print(json.dumps({"logGroups": [
            {"logGroupName": group} for group in json.loads(state_path.read_text())
        ]}))
    elif operation == ["logs", "create-log-group"]:
        group = arg("--log-group-name")
        log_region = arg("--region")
        state_path = storage / ("logs-" + log_region + "-" + group.rsplit("/", 1)[-1] + ".json")
        if not state_path.exists():
            state_path.write_text(json.dumps([
                group,
                group + ".local",
                group + "/rev-1",
                group + "-foreign/rev-1",
                group + ".local-foreign",
            ]))
        groups = json.loads(state_path.read_text())
        if group in groups:
            print("ResourceAlreadyExistsException: log group exists", file=sys.stderr)
            sys.exit(255)
        groups.append(group)
        state_path.write_text(json.dumps(groups))
    elif operation == ["logs", "put-retention-policy"]:
        pass
    elif operation == ["logs", "delete-log-group"]:
        if not os.environ.get("TRIVIA_TEST_LOG_DELETE_IGNORED"):
            group = arg("--log-group-name")
            for state_path in storage.glob("logs-*.json"):
                groups = json.loads(state_path.read_text())
                state_path.write_text(json.dumps([candidate for candidate in groups
                                                  if candidate != group]))
    else:
        raise RuntimeError("unexpected AWS command: " + str(args))
else:
    raise RuntimeError("unexpected tool: " + tool)
'''


class EnvironmentTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="trivia-environment-test-")
        self.directory = Path(self.temporary.name).resolve()
        # Copy source inputs only. Fake builds produce dist explicitly, so
        # ignored output in a developer's checkout cannot make tests pass.
        self.root = self.directory / "project"
        shutil.copytree(ROOT / "scripts", self.root / "scripts",
                        ignore=shutil.ignore_patterns("__pycache__"))
        shutil.copytree(ROOT / "packages", self.root / "packages",
                        ignore=shutil.ignore_patterns("node_modules", "dist", "*.tsbuildinfo"))
        shutil.copy2(ROOT / "package.json", self.root / "package.json")
        (self.root / "infra/terraform").mkdir(parents=True)
        if (ROOT / "deploy/locks").exists():
            shutil.copytree(ROOT / "deploy/locks", self.root / "deploy/locks",
                            ignore=shutil.ignore_patterns("node_modules"))
        fake_bin = self.directory / "bin"
        fake_bin.mkdir()
        for tool in ["terraform", "aws", "npm", "zip", "curl"]:
            path = fake_bin / tool
            path.write_text(f"#!{sys.executable}\n" + FAKE_CLI)
            path.chmod(0o755)
        self.environment = dict(os.environ)
        for key in ["TRIVIA_ENV_NAME", "API_FUNCTION", "WEB_FUNCTION", "TABLE_PREFIX",
                    "API_BASE_URL", "TF_WORKSPACE", "REGION", "REVISION_ID",
                    "WEB_ORIGIN", "EARLY_REVEAL", "ENDPOINT_RATE_LIMIT",
                    "ENDPOINT_MAX_ENVIRONMENTS", "LOG_RETENTION_DAYS"]:
            self.environment.pop(key, None)
        self.environment.update(PATH=f"{fake_bin}:{os.environ['PATH']}",
                                TRIVIA_TEST_DIR=str(self.directory))

    def tearDown(self):
        self.temporary.cleanup()

    def run_script(self, script, *args, environment="demo1", extra=None, success=True):
        env = dict(self.environment, TRIVIA_ENV_NAME=environment)
        env.update(extra or {})
        # Fixed repository scripts and unittest arguments, with no command shell.
        result = subprocess.run([BASH, str(self.root / "scripts" / script), *args],
                                cwd=self.root, env=env, text=True, capture_output=True, shell=False)  # nosec B603
        if success:
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        else:
            self.assertNotEqual(result.returncode, 0, result.stdout + result.stderr)
        return result

    def calls(self):
        path = self.directory / "calls.jsonl"
        return [json.loads(line) for line in path.read_text().splitlines()] if path.exists() else []

    def patch_api_endpoint(self, patch):
        path = self.directory / "serverlessq-demo1-api.endpoint.json"
        endpoint = json.loads(path.read_text())
        endpoint.update(patch)
        path.write_text(json.dumps(endpoint))

    def test_deployment_rejects_removed_modes_before_calling_external_tools(self):
        for arguments in [("prepare",), ("api", "package"), ("web", "build")]:
            with self.subTest(arguments=arguments):
                start = len(self.calls())
                self.run_script("deploy.sh", *arguments, success=False)
                self.assertEqual(len(self.calls()), start)

    def test_deployment_accepts_only_the_selected_terraform_function_names(self):
        for environment in ["", "demo1"]:
            prefix = "serverlessq" + ("-" + environment if environment else "")
            for kind in ["api", "web"]:
                self.run_script("deploy.sh", kind, environment=environment,
                                extra={kind.upper() + "_FUNCTION": prefix + "-" + kind + "-prepared"},
                                success=False)
        self.assertFalse(any(call["args"][:2] in [
            ["s3api", "put-object"], ["lambda-web", "create-web-function"],
            ["lambda-web", "create-web-function-revision"]] for call in self.calls()))

    def test_deployment_uses_committed_production_locks(self):
        for function in ["api", "web"]:
            with self.subTest(function=function):
                self.assertFalse((self.root / f"packages/{function}/dist").exists())
                start = len(self.calls())
                self.run_script("deploy.sh", function,
                                extra={"API_BASE_URL": "https://api.example.test"})
                calls = self.calls()[start:]
                installs = [call for call in calls if call["tool"] == "npm"
                            and call["args"][0] in ["ci", "install"]]
                self.assertEqual(len(installs), 1)
                install = installs[0]
                self.assertEqual(install["args"], [
                    "ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"])
                committed = ROOT / "deploy/locks" / function
                self.assertEqual(install["manifest"], (committed / "package.json").read_text())
                self.assertEqual(install["lock"], (committed / "package-lock.json").read_text())
                manifest = json.loads(install["manifest"])
                self.assertNotIn("devDependencies", manifest)
                self.assertNotIn("@serverlessq/shared", manifest["dependencies"])
                self.assertFalse(install["shared_present"])
                archive = next(call for call in calls if call["tool"] == "zip")
                self.assertEqual(archive["cwd"], install["cwd"])
                self.assertEqual(archive["files"]["package.json"], install["manifest"])
                self.assertEqual(archive["files"]["package-lock.json"], install["lock"])
                if function == "api":
                    api_dependencies = json.loads(
                        (self.root / "packages/api/package.json").read_text())["dependencies"]
                    shared_dependencies = json.loads(
                        (self.root / "packages/shared/package.json").read_text())["dependencies"]
                    self.assertEqual(set(manifest["dependencies"]),
                                     (set(api_dependencies) | set(shared_dependencies))
                                     - {"@serverlessq/shared"})
                    self.assertEqual(archive["files"]["node_modules/@serverlessq/shared/package.json"],
                                     (self.root / "packages/shared/package.json").read_text())
                    self.assertEqual(archive["files"]["node_modules/@serverlessq/shared/dist/index.js"],
                                     "// explicit test build output\n")
                else:
                    self.assertNotIn("node_modules/@serverlessq/shared/package.json", archive["files"])
                    self.assertEqual(set(manifest["dependencies"]), {"express"})
                    self.assertEqual(archive["files"]["dist/index.js"],
                                     "// explicit test build output\n")
                self.assertFalse(any(call["tool"] == "npm"
                                     and call["args"][0] in ["pkg", "pack"] for call in calls))
                self.assertEqual(sum(call["args"][:2] == ["s3api", "put-object"]
                                     for call in calls), 1)
                self.assertFalse(Path(install["cwd"]).exists())
        for function in ["api", "web"]:
            with self.subTest(failed_install=function):
                start = len(self.calls())
                result = self.run_script(
                    "deploy.sh", function,
                    extra={"TRIVIA_TEST_CI_FAIL": "1",
                           "API_BASE_URL": "https://api.example.test"}, success=False)
                self.assertIn("test locked installation failed", result.stderr)
                calls = self.calls()[start:]
                self.assertFalse(any(call["args"][:2] == ["s3api", "put-object"]
                                     for call in calls))
                install = next(call for call in calls if call["tool"] == "npm"
                               and call["args"][0] == "ci")
                self.assertFalse(Path(install["cwd"]).exists())

    def test_build_failure_stops_before_packaging_and_upload(self):
        result = self.run_script("deploy.sh", "api",
                                 extra={"TRIVIA_TEST_BUILD_FAIL": "1"}, success=False)
        self.assertIn("test compiler error", result.stdout)
        self.assertIn("Shared build failed", result.stderr)
        self.assertFalse(any(call["tool"] == "zip" or call["args"][:2] == ["s3api", "put-object"]
                             for call in self.calls()))

    def test_deployment_passes_environment_overrides_to_both_functions(self):
        overrides = {
            "API_BASE_URL": "https://api.example.test",
            "WEB_ORIGIN": "https://web.example.test",
            "EARLY_REVEAL": "false",
            "REVISION_ID": 'revision-"quoted"',
            "TRIVIA_TEST_DDB_REGION": "us-west-2",
            "TRIVIA_TEST_COGNITO_REGION": "eu-west-1",
        }
        for kind in ["api", "web"]:
            self.run_script("deploy.sh", kind, extra=overrides)
            settings = json.loads((self.directory / f"serverlessq-demo1-{kind}.env.json").read_text())
            self.assertEqual(settings["DDB_REGION"], "us-west-2")
            self.assertEqual(settings["COGNITO_REGION"], "eu-west-1")
            self.assertEqual(settings["TRIVIA_FUNCTION_NAME"], "serverlessq-demo1-api")
            for key in ["API_BASE_URL", "WEB_ORIGIN", "EARLY_REVEAL", "REVISION_ID"]:
                self.assertEqual(settings[key], overrides[key])

    def test_four_deployments_use_separate_workspaces_and_data(self):
        for name in ["demo1", "demo2", "demo3", "demo4"]:
            self.run_script("terraform.sh", "init", environment=name)
            self.run_script("seed.sh", environment=name)
            self.run_script("deploy.sh", "api", environment=name)
            self.run_script("deploy.sh", "web", environment=name)
        creates = [c for c in self.calls() if c["tool"] == "aws"
                   and c["args"][:2] == ["lambda-web", "create-web-function"]]
        self.assertEqual(len(creates), 8)
        for call in creates:
            args = call["args"]
            name = call["workspace"]
            function = args[args.index("--function-name") + 1]
            self.assertIn(function, [f"serverlessq-{name}-api", f"serverlessq-{name}-web"])
            revision = json.loads(args[args.index("--revision-config") + 1])
            settings = revision["serviceConfig"]["environmentVariables"]
            self.assertEqual(settings["TRIVIA_ENV_NAME"], name)
            self.assertEqual(settings["SERVERLESSQ_TABLE_PREFIX"], f"{name}-")
            self.assertEqual(settings["COGNITO_USER_POOL_ID"], f"us-east-1_{name}")
            self.assertEqual(settings["COGNITO_APP_CLIENT_ID"], f"client-{name}")
            self.assertEqual(revision["buildConfig"]["codeConfig"]["s3Object"]["bucket"],
                             f"serverlessq-{name}-web-code-123456789012")
            if function.endswith("-web"):
                self.assertEqual(settings["API_BASE_URL"], f"https://serverlessq-{name}-api.example.test")

    def test_default_deployment_can_use_old_state(self):
        self.run_script("deploy.sh", "api", environment="")
        create = next(c for c in self.calls() if c["args"][:2] == ["lambda-web", "create-web-function"])
        args = create["args"]
        self.assertEqual(args[args.index("--function-name") + 1], "serverlessq-api")
        revision = json.loads(args[args.index("--revision-config") + 1])
        self.assertEqual(revision["serviceConfig"]["environmentVariables"]["SERVERLESSQ_TABLE_PREFIX"], "dev-")
        self.assertNotIn("TRIVIA_ENV_NAME", revision["serviceConfig"]["environmentVariables"])

    def test_endpoint_traffic_controls(self):
        self.run_script(
            "deploy.sh", "api",
            extra={"ENDPOINT_RATE_LIMIT": "300", "ENDPOINT_MAX_ENVIRONMENTS": "12"})
        api_create = next(c for c in self.calls()
                          if c["args"][:2] == ["lambda-web", "create-web-function"])
        api_args = api_create["args"]
        api_endpoint = json.loads(api_args[api_args.index("--endpoint-config") + 1])
        self.assertEqual(api_endpoint["throttleConfig"], {"rateLimit": 300})
        self.assertEqual(api_endpoint["scalingConfig"], {"maxEnvironments": 12})

        self.run_script("deploy.sh", "web")
        web_create = [c for c in self.calls()
                      if c["args"][:2] == ["lambda-web", "create-web-function"]][-1]
        web_args = web_create["args"]
        web_endpoint = json.loads(web_args[web_args.index("--endpoint-config") + 1])
        self.assertEqual(web_endpoint["throttleConfig"], {"rateLimit": 100})
        self.assertEqual(web_endpoint["scalingConfig"], {"maxEnvironments": 10})

        invalid_values = {
            "ENDPOINT_RATE_LIMIT": ["-1", "1.5", "many", "1", "99", "250", "1100", "10001"],
            "ENDPOINT_MAX_ENVIRONMENTS": ["0", "1", "10001", "-1", "1.5", "many"],
        }
        for variable, values in invalid_values.items():
            for value in values:
                with self.subTest(variable=variable, value=value):
                    call_count = len(self.calls())
                    self.run_script(
                        "deploy.sh", "api", extra={variable: value}, success=False)
                    self.assertEqual(len(self.calls()), call_count)

    def test_api_creation_has_safe_endpoint_defaults(self):
        self.run_script("deploy.sh", "api", extra={
            "ENDPOINT_RATE_LIMIT": "", "ENDPOINT_MAX_ENVIRONMENTS": "",
        })
        create = next(c for c in self.calls()
                      if c["args"][:2] == ["lambda-web", "create-web-function"])
        args = create["args"]
        endpoint = json.loads(args[args.index("--endpoint-config") + 1])
        self.assertEqual(endpoint["throttleConfig"], {"rateLimit": 100})
        self.assertEqual(endpoint["scalingConfig"], {"maxEnvironments": 10})
        revision = json.loads(args[args.index("--revision-config") + 1])
        self.assertNotIn("WEB_ORIGIN", revision["serviceConfig"]["environmentVariables"])

    def test_extreme_environment_caps_are_rejected_before_external_calls(self):
        for value in ["18446744073709551618", "18446744073709561616", "9" * 100]:
            with self.subTest(value=value):
                start = len(self.calls())
                self.run_script("deploy.sh", "api",
                                extra={"ENDPOINT_MAX_ENVIRONMENTS": value}, success=False)
                self.assertEqual(len(self.calls()), start)

    def test_no_argument_deployment_validates_both_function_names_before_writes(self):
        self.run_script("deploy.sh",
                        extra={"WEB_FUNCTION": "serverlessq-demo1-web-foreign"}, success=False)
        self.assertFalse(any(call["args"][:2] in [
            ["s3api", "put-object"], ["lambda-web", "create-web-function"],
            ["lambda-web", "create-web-function-revision"]] for call in self.calls()))

    def test_no_argument_deployment_orders_api_web_and_exact_origin_revision(self):
        self.run_script("deploy.sh", extra={"WEB_ORIGIN": "https://unrelated.example.test"})
        writes = [c for c in self.calls() if c["args"][:2] in [
            ["lambda-web", "create-web-function"],
            ["lambda-web", "create-web-function-revision"]]]
        self.assertEqual([(c["args"][1], c["args"][c["args"].index("--function-name") + 1])
                          for c in writes], [
            ("create-web-function", "serverlessq-demo1-api"),
            ("create-web-function", "serverlessq-demo1-web"),
            ("create-web-function-revision", "serverlessq-demo1-api")])
        first = json.loads(writes[0]["args"][writes[0]["args"].index("--revision-config") + 1])
        self.assertNotIn("WEB_ORIGIN", first["serviceConfig"]["environmentVariables"])
        web = json.loads((self.directory / "serverlessq-demo1-web.env.json").read_text())
        self.assertEqual(web["API_BASE_URL"], "https://serverlessq-demo1-api.example.test")
        api = json.loads((self.directory / "serverlessq-demo1-api.env.json").read_text())
        self.assertEqual(api["WEB_ORIGIN"], "https://serverlessq-demo1-web.example.test")
        self.assertEqual(api["COGNITO_USER_POOL_ID"], "us-east-1_demo1")
        waits = [c["args"] for c in self.calls()
                 if c["args"][:3] == ["lambda-web", "wait", "web-function-revision-active"]]
        self.assertEqual([args[args.index("--revision-id") + 1] for args in waits],
                         ["revision-A", "revision-A", "revision-B"])

    def test_no_argument_deployment_passes_endpoint_overrides_to_both_creations(self):
        self.run_script("deploy.sh", extra={
            "ENDPOINT_RATE_LIMIT": "200", "ENDPOINT_MAX_ENVIRONMENTS": "5",
        })
        creates = [c["args"] for c in self.calls()
                   if c["args"][:2] == ["lambda-web", "create-web-function"]]
        self.assertEqual(len(creates), 2)
        for args in creates:
            endpoint = json.loads(args[args.index("--endpoint-config") + 1])
            self.assertEqual(endpoint["throttleConfig"], {"rateLimit": 200})
            self.assertEqual(endpoint["scalingConfig"], {"maxEnvironments": 5})

    def test_wait_failure_stops_deployment_and_is_not_reported_as_success(self):
        result = self.run_script("deploy.sh", extra={"TRIVIA_TEST_WAIT_FAIL": "1"}, success=False)
        self.assertIn("Waiter failed", result.stderr)
        self.assertNotIn("Deployed", result.stdout)
        self.assertFalse((self.directory / "function.serverlessq-demo1-web").exists())

    def test_revision_wait_failure_and_smoke_failure_propagate(self):
        self.run_script("deploy.sh", "api")
        result = self.run_script("deploy.sh", "api",
                                 extra={"TRIVIA_TEST_WAIT_FAIL": "1"}, success=False)
        self.assertIn("Waiter failed", result.stderr)
        self.assertNotIn("Deployed", result.stdout)
        result = self.run_script("deploy.sh", "api",
                                 extra={"TRIVIA_TEST_SMOKE_FAIL": "1"}, success=False)
        self.assertIn("test smoke failed", result.stderr)

    def test_web_wait_failure_stops_before_final_api_revision(self):
        result = self.run_script("deploy.sh", extra={
            "TRIVIA_TEST_WAIT_FAIL_FUNCTION": "serverlessq-demo1-web",
            "TRIVIA_TEST_WAIT_FAIL_KIND": "web-function-endpoint-active",
        }, success=False)
        self.assertIn("Waiter failed", result.stderr)
        self.assertFalse(any(call["args"][:2] ==
                             ["lambda-web", "create-web-function-revision"]
                             for call in self.calls()))

    def test_final_api_wait_failure_stops_before_the_workflow_success_summary(self):
        result = self.run_script("deploy.sh", extra={
            "TRIVIA_TEST_WAIT_FAIL_FUNCTION": "serverlessq-demo1-api",
            "TRIVIA_TEST_WAIT_FAIL_KIND": "web-function-revision-active",
            "TRIVIA_TEST_WAIT_FAIL_REVISION": "revision-B",
        }, success=False)
        self.assertIn("Waiter failed", result.stderr)
        self.assertNotIn("Web →", result.stdout)
        self.assertEqual(sum(call["args"][:2] ==
                             ["lambda-web", "create-web-function-revision"]
                             for call in self.calls()), 1)

    def test_missing_created_revision_id_stops_before_waiting(self):
        self.run_script("deploy.sh", "api")
        start = len(self.calls())
        result = self.run_script("deploy.sh", "api",
                                 extra={"TRIVIA_TEST_REVISION_ID": "None"}, success=False)
        self.assertIn("Created revision ID is missing", result.stderr)
        self.assertFalse(any(call["args"][:2] == ["lambda-web", "wait"]
                             for call in self.calls()[start:]))

    def test_active_home_serving_old_revision_rejects_new_revision_deployment(self):
        self.run_script("deploy.sh", "api")
        start = len(self.calls())
        result = self.run_script("deploy.sh", "api",
                                 extra={"TRIVIA_TEST_HOME_STALE": "1"}, success=False)
        self.assertNotIn("Deployed", result.stdout)
        self.assertFalse(any(call["tool"] == "curl" for call in self.calls()[start:]))

    def test_incompatible_existing_home_is_rejected_before_build_or_mutation(self):
        self.run_script("deploy.sh", "api")
        cases = [
            {"endpointType": "MultiRegion"}, {"authType": "IamAuth"},
            {"autoDeploymentMode": "Disabled"}, {"autoDeploymentMode": None},
            {"regions": ["us-east-1", "us-west-2"]}, {"endpointName": "foreign"},
            {"revisionWeights": []}, {"revisionWeights": [{"revisionId": "", "weight": 100}]},
            {"revisionWeights": [{"revisionId": "revision-A", "weight": 90},
                                 {"revisionId": "revision-old", "weight": 10}]},
            {"state": "Failed"}, {"updateStatus": "InProgress"}, {"updateStatus": "Failed"},
        ]
        path = self.directory / "serverlessq-demo1-api.endpoint.json"
        original = path.read_text()
        for patch in cases:
            with self.subTest(patch=patch):
                path.write_text(original)
                self.patch_api_endpoint(patch)
                start = len(self.calls())
                self.run_script("deploy.sh", "api", success=False)
                self.assertFalse(any(call["tool"] in ["npm", "zip", "curl"] or
                                     call["args"][:2] in [
                                         ["s3api", "put-object"],
                                         ["lambda-web", "create-web-function-revision"],
                                         ["lambda-web", "update-web-function-endpoint"]]
                                     for call in self.calls()[start:]))

    def test_endpoint_update_waiter_failure_stops_before_success_or_smoke(self):
        self.run_script("deploy.sh", "api")
        start = len(self.calls())
        result = self.run_script("deploy.sh", "api", extra={
            "TRIVIA_TEST_WAIT_FAIL_FUNCTION": "serverlessq-demo1-api",
            "TRIVIA_TEST_WAIT_FAIL_KIND": "web-function-endpoint-updated",
            "TRIVIA_TEST_HOME_AFTER": json.dumps({"updateStatus": "InProgress"}),
        }, success=False)
        self.assertIn("Waiter failed", result.stderr)
        self.assertNotIn("Deployed", result.stdout)
        self.assertFalse(any(call["tool"] == "curl" for call in self.calls()[start:]))

    def test_latest_revision_auto_follow_needs_no_explicit_update_status(self):
        self.run_script("deploy.sh", "api")
        start = len(self.calls())
        self.run_script("deploy.sh", "api", extra={"TRIVIA_TEST_NO_UPDATE_STATUS": "1"})
        endpoint = json.loads((self.directory / "serverlessq-demo1-api.endpoint.json").read_text())
        self.assertNotIn("updateStatus", endpoint)
        self.assertEqual(endpoint["revisionWeights"], [{"revisionId": "revision-B", "weight": 100}])
        self.assertFalse(any(call["args"][:3] ==
                             ["lambda-web", "wait", "web-function-endpoint-updated"]
                             for call in self.calls()[start:]))
        self.assertTrue(any(call["tool"] == "curl" for call in self.calls()[start:]))

    def test_no_argument_checks_existing_web_mode_before_api_mutation(self):
        self.run_script("deploy.sh", "web", extra={"API_BASE_URL": "https://api.example.test"})
        path = self.directory / "serverlessq-demo1-web.endpoint.json"
        endpoint = json.loads(path.read_text())
        endpoint["autoDeploymentMode"] = "Disabled"
        path.write_text(json.dumps(endpoint))
        start = len(self.calls())
        self.run_script("deploy.sh", success=False)
        self.assertFalse(any(call["args"][:2] in [
            ["s3api", "put-object"], ["lambda-web", "create-web-function"],
            ["lambda-web", "create-web-function-revision"]] for call in self.calls()[start:]))

    def test_function_lookup_error_is_not_treated_as_permission_to_create(self):
        start = len(self.calls())
        self.run_script("deploy.sh", "api", extra={
            "TRIVIA_TEST_FUNCTION_LOOKUP_FAIL": "1",
        }, success=False)
        self.assertFalse(any(call["tool"] in ["npm", "zip", "curl"] or
                             call["args"][:2] in [
                                 ["s3api", "put-object"], ["lambda-web", "create-web-function"]]
                             for call in self.calls()[start:]))

    def test_incorrect_final_endpoint_configuration_is_rejected_before_smoke(self):
        self.run_script("deploy.sh", "api")
        cases = [
            {"state": "Failed"}, {"updateStatus": "Failed"}, {"updateStatus": "InProgress"},
            {"autoDeploymentMode": "Disabled"}, {"authType": "IamAuth"},
            {"revisionWeights": []}, {"revisionWeights": [{"revisionId": None, "weight": 100}]},
            {"revisionWeights": [{"revisionId": "revision-B", "weight": 90},
                                 {"revisionId": "revision-A", "weight": 10}]},
            {"throttleConfig": {"rateLimit": 0}}, {"scalingConfig": {"maxEnvironments": 999}},
            {"regionalEndpoints": {"us-east-1": {
                "authType": "ApplicationManaged", "state": "Active",
                "revisionWeights": [{"revisionId": "revision-A", "weight": 100}],
                "throttleConfig": {"rateLimit": 100}, "scalingConfig": {"maxEnvironments": 10},
            }}},
        ]
        path = self.directory / "serverlessq-demo1-api.endpoint.json"
        original = path.read_text()
        for patch in cases:
            with self.subTest(patch=patch):
                path.write_text(original)
                start = len(self.calls())
                result = self.run_script("deploy.sh", "api", extra={
                    "TRIVIA_TEST_HOME_AFTER": json.dumps(patch),
                }, success=False)
                self.assertNotIn("Deployed", result.stdout)
                self.assertFalse(any(call["tool"] == "curl" for call in self.calls()[start:]))

    def test_deployment_sets_bounded_log_retention(self):
        self.run_script("deploy.sh", "api", extra={"LOG_RETENTION_DAYS": "30"})
        retention = {
            (
                call["args"][call["args"].index("--log-group-name") + 1],
                call["args"][call["args"].index("--retention-in-days") + 1],
                call["args"][call["args"].index("--region") + 1],
            )
            for call in self.calls()
            if call["args"][:2] == ["logs", "put-retention-policy"]
        }
        self.assertEqual(retention, {
            ("/aws/lambda/web/serverlessq-demo1-api", "30", "us-east-1"),
            ("/aws/lambda/web/serverlessq-demo1-api.local", "30", "us-east-1"),
        })
        self.run_script(
            "deploy.sh", "api",
            extra={"LOG_RETENTION_DAYS": "2"},
            success=False,
        )

    def test_returned_revision_must_have_the_requested_configuration(self):
        self.run_script("deploy.sh", "api")
        for patch in [
            {"revisionId": "revision-A"}, {"state": "Failed"},
            {"serviceConfig": {"environmentVariables": {"WEB_ORIGIN": "https://foreign.example.test"}}},
            {"buildConfig": {"runtimeConfig": {"runtime": "nodejs24.x"},
                             "codeConfig": {"s3Object": {"versionId": "old-version"}}}},
        ]:
            with self.subTest(patch=patch):
                start = len(self.calls())
                result = self.run_script("deploy.sh", "api", extra={
                    "TRIVIA_TEST_REVISION_AFTER": json.dumps(patch),
                }, success=False)
                self.assertNotIn("Deployed", result.stdout)
                self.assertFalse(any(call["tool"] == "curl" for call in self.calls()[start:]))

    def test_initial_creation_requires_its_returned_revision_id(self):
        result = self.run_script("deploy.sh", "api",
                                 extra={"TRIVIA_TEST_REVISION_ID": "None"}, success=False)
        self.assertIn("Created revision ID is missing", result.stderr)
        self.assertFalse(any(call["args"][:2] == ["lambda-web", "wait"] or
                             call["tool"] == "curl" for call in self.calls()))

    def test_targeted_revision_preserves_controls_and_checks_effective_traffic(self):
        self.run_script("deploy.sh", "api", extra={
            "ENDPOINT_RATE_LIMIT": "300", "ENDPOINT_MAX_ENVIRONMENTS": "12",
        })
        start = len(self.calls())
        self.run_script("deploy.sh", "api", extra={
            "ENDPOINT_RATE_LIMIT": "0", "ENDPOINT_MAX_ENVIRONMENTS": "2",
        })
        endpoint = json.loads((self.directory / "serverlessq-demo1-api.endpoint.json").read_text())
        self.assertEqual(endpoint["throttleConfig"], {"rateLimit": 300})
        self.assertEqual(endpoint["scalingConfig"], {"maxEnvironments": 12})
        self.assertEqual(endpoint["revisionWeights"], [{"revisionId": "revision-B", "weight": 100}])
        self.assertTrue(any(call["tool"] == "curl" for call in self.calls()[start:]))
        self.assertFalse(any(call["args"][:2] == ["lambda-web", "update-web-function-endpoint"]
                             for call in self.calls()[start:]))
        self.run_script("deploy.sh", "api", extra={
            "ENDPOINT_RATE_LIMIT": "0", "TRIVIA_TEST_SMOKE_FAIL": "1",
        }, success=False)

    def test_zero_rate_no_argument_deployment_completes_using_control_plane(self):
        result = self.run_script("deploy.sh", extra={
            "ENDPOINT_RATE_LIMIT": "0", "ENDPOINT_MAX_ENVIRONMENTS": "5",
        })
        writes = [call["args"] for call in self.calls() if call["args"][:2] in [
            ["lambda-web", "create-web-function"], ["lambda-web", "create-web-function-revision"]]]
        self.assertEqual([(args[1], args[args.index("--function-name") + 1]) for args in writes], [
            ("create-web-function", "serverlessq-demo1-api"),
            ("create-web-function", "serverlessq-demo1-web"),
            ("create-web-function-revision", "serverlessq-demo1-api"),
        ])
        for function in ["api", "web"]:
            endpoint = json.loads((self.directory / f"serverlessq-demo1-{function}.endpoint.json").read_text())
            self.assertEqual(endpoint["throttleConfig"], {"rateLimit": 0})
            self.assertEqual(endpoint["scalingConfig"], {"maxEnvironments": 5})
        api = json.loads((self.directory / "serverlessq-demo1-api.env.json").read_text())
        self.assertEqual(api["WEB_ORIGIN"], "https://serverlessq-demo1-web.example.test")
        endpoint = json.loads((self.directory / "serverlessq-demo1-api.endpoint.json").read_text())
        self.assertEqual(endpoint["revisionWeights"], [{"revisionId": "revision-B", "weight": 100}])
        self.assertFalse(any(call["tool"] == "curl" for call in self.calls()))
        self.assertNotIn("Smoke:", result.stdout)
        self.assertIn("Web →", result.stdout)
        self.assertIn("HTTP smoke skipped", result.stdout)

    def test_zero_rate_creation_rejects_ineffective_controls_before_smoke(self):
        for patch in [{"throttleConfig": {"rateLimit": 100}},
                      {"throttleConfig": None}, {"scalingConfig": {"maxEnvironments": 10}}]:
            with self.subTest(patch=patch):
                # Use a fresh environment for every new-function control mismatch.
                function = "serverlessq-demo1-api"
                (self.directory / ("function." + function)).unlink(missing_ok=True)
                start = len(self.calls())
                result = self.run_script("deploy.sh", "api", extra={
                    "ENDPOINT_RATE_LIMIT": "0", "ENDPOINT_MAX_ENVIRONMENTS": "5",
                    "TRIVIA_TEST_HOME_AFTER": json.dumps(patch),
                }, success=False)
                self.assertNotIn("Deployed", result.stdout)
                self.assertFalse(any(call["tool"] == "curl" for call in self.calls()[start:]))

    def test_traffic_enabled_no_argument_smoke_failure_stops_before_web(self):
        result = self.run_script("deploy.sh", extra={
            "ENDPOINT_RATE_LIMIT": "100", "TRIVIA_TEST_SMOKE_FAIL": "1",
        }, success=False)
        self.assertEqual(result.returncode, 22)
        self.assertIn("test smoke failed", result.stderr)
        self.assertFalse((self.directory / "function.serverlessq-demo1-web").exists())

    def test_invalid_and_mismatched_environments_stop_before_deployment(self):
        for name in ["../bad", "Demo1", "default", "demo--1", "demo1-", "1demo", "a" * 21]:
            self.run_script("terraform.sh", "apply", environment=name, success=False)
        self.assertEqual(self.calls(), [])
        for extra in [{"API_FUNCTION": "serverlessq-demo2-api"},
                      {"API_FUNCTION": "serverlessq-demo1-api-foreign-api"},
                      {"TABLE_PREFIX": "demo2-"}, {"TRIVIA_TEST_WRONG_STATE": "1"},
                      {"TRIVIA_TEST_ACCOUNT": "987654321098"}]:
            self.run_script("deploy.sh", "api", extra=extra, success=False)
        self.assertFalse(any(c["args"][:2] == ["s3api", "put-object"] for c in self.calls()))

    def test_teardown_uses_selected_state_and_exact_log_and_table_names(self):
        self.run_script("deploy.sh", "api", environment="demo2")
        self.run_script("deploy.sh", "api", environment="demo1")
        dry_run = self.run_script("teardown.sh", "--dry-run")
        self.assertIn("demo1", dry_run.stdout)
        self.assertFalse(any(c["args"][:2] == ["lambda-web", "delete-web-function"] for c in self.calls()))
        self.run_script("teardown.sh", "--yes")
        self.assertTrue((self.directory / "function.serverlessq-demo2-api").exists())
        self.assertTrue((self.directory / "demo1.destroyed").exists())
        self.assertFalse((self.directory / "demo2.destroyed").exists())
        destroys = [call for call in self.calls()
                    if call["tool"] == "terraform" and "destroy" in call["args"]]
        self.assertEqual(len(destroys), 1)
        self.assertIn("-var=primary_region=us-east-1", destroys[0]["args"])
        deleted_log_groups = {
            (
                call["args"][call["args"].index("--log-group-name") + 1],
                call["args"][call["args"].index("--region") + 1],
            )
            for call in self.calls()
            if call["args"][:2] == ["logs", "delete-log-group"]
        }
        expected_log_groups = {
            (f"/aws/lambda/web/serverlessq-demo1-{function}{suffix}", "us-east-1")
            for function in ["api", "web"]
            for suffix in ["", ".local", "/rev-1"]
        }
        expected_log_groups.update({
            (f"/aws/lambda/web/serverlessq-demo1-{function}.local", "us-west-2")
            for function in ["api", "web"]
        })
        self.assertEqual(deleted_log_groups, expected_log_groups)
        for call in self.calls():
            if call["args"][:2] == ["logs", "delete-log-group"]:
                group = call["args"][call["args"].index("--log-group-name") + 1]
                self.assertNotIn("-foreign", group)
            if call["args"][:2] == ["dynamodb", "describe-table"]:
                self.assertTrue(call["args"][3].startswith("demo1-serverlessq-"))
        self.run_script("teardown.sh", "--yes", extra={"REGION": "us-east-1"})  # empty-state rerun
        rerun = self.run_script("teardown.sh", "--dry-run", extra={"REGION": "us-east-1"})
        self.assertIn("serverlessq-demo1-web-code-123456789012-us-east-1", rerun.stdout)

    def test_teardown_fails_if_an_exact_log_group_survives_deletion(self):
        result = self.run_script(
            "teardown.sh", "--yes",
            extra={"TRIVIA_TEST_LOG_DELETE_IGNORED": "1"},
            success=False,
        )
        self.assertIn("log group(s) survived", result.stderr)
        self.assertIn("Terraform state was retained", result.stderr)
        self.assertIn("STILL PRESENT: log group", result.stdout)



if __name__ == "__main__":
    unittest.main()
