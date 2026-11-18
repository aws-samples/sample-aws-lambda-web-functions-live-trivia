/** Do not pass developer/runner credentials or user scanner settings to tools. */
export function scannerEnvironment(directory) {
  const environment = {};
  for (const key of [
    'PATH',
    'TMPDIR',
    'TMP',
    'TEMP',
    'LANG',
    'LC_ALL',
    'SYSTEMROOT',
    'SSL_CERT_FILE',
    'SSL_CERT_DIR',
  ]) {
    if (process.env[key]) environment[key] = process.env[key];
  }
  return {
    ...environment,
    HOME: directory,
    XDG_CONFIG_HOME: directory,
    AWS_EC2_METADATA_DISABLED: 'true',
    AWS_CONFIG_FILE: '/dev/null',
    AWS_SHARED_CREDENTIALS_FILE: '/dev/null',
    PIP_CONFIG_FILE: '/dev/null',
    PIP_DISABLE_PIP_VERSION_CHECK: '1',
    SEMGREP_SEND_METRICS: 'off',
    SEMGREP_ENABLE_VERSION_CHECK: '0',
    CHECKOV_TELEMETRY: 'false',
  };
}
