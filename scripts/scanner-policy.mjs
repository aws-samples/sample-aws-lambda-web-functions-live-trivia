const APPROVED_BANDIT_EXCEPTIONS = [
  {
    file: 'scripts/environment.test.py',
    line: 8,
    check_id: 'B404',
    rationale: 'Test-only harness imports subprocess to run fixed local scripts against fake CLIs.',
  },
  {
    file: 'scripts/environment.test.py',
    line: 313,
    check_id: 'B603',
    rationale: 'Test-only harness executes a fixed Bash path and argument array with shell disabled.',
  },
];

export const APPROVED_CHECKOV_EXCEPTIONS = [
  {
    check_id: 'CKV_AWS_18',
    resource: 'aws_s3_bucket.code',
    file: 's3.tf',
    rationale:
      'Private rebuildable deployment ZIPs; S3 server access logging is not provisioned.',
  },
  {
    check_id: 'CKV_AWS_144',
    resource: 'aws_s3_bucket.code',
    file: 's3.tf',
    rationale:
      'Rebuildable deployment ZIPs in one private region do not require cross-region replication.',
  },
  {
    check_id: 'CKV2_AWS_62',
    resource: 'aws_s3_bucket.code',
    file: 's3.tf',
    rationale:
      'No application consumer depends on deployment-artifact upload event notifications.',
  },
  {
    check_id: 'CKV_AWS_145',
    resource: 'aws_s3_bucket.code',
    file: 's3.tf',
    rationale:
      'Rebuildable ZIPs use S3-managed default encryption; this artifact bucket does not require KMS-by-default.',
  },
  ...[
    'question_sets',
    'questions',
    'games',
    'participants',
    'answers',
    'scores',
  ].map((resource) => ({
    check_id: 'CKV_AWS_119',
    resource: `aws_dynamodb_table.${resource}`,
    file: 'dynamodb.tf',
    rationale:
      'Educational trivia sample retains DynamoDB AWS-owned encryption; customer-managed key control and auditing are outside its scope.',
  })),
];

function canonical(value) {
  return JSON.stringify(
    [...value]
      .map((entry) =>
        Object.fromEntries(
          Object.entries(entry).sort(([left], [right]) => left.localeCompare(right)),
        ),
      )
      .sort((left, right) =>
        `${left.file}:${left.resource ?? ''}:${left.line ?? 0}:${left.check_id}`.localeCompare(
          `${right.file}:${right.resource ?? ''}:${right.line ?? 0}:${right.check_id}`,
        ),
      ),
  );
}

function requireExactPolicy(actual, approved, label) {
  if (!Array.isArray(actual) || canonical(actual) !== canonical(approved)) {
    throw new Error(`${label} exception manifest differs from the reviewed publication policy`);
  }
}

export function validateBanditSourceExceptions(sources, exceptions) {
  validateBanditExceptionPolicy(exceptions);
  const actual = [];
  const marker = new RegExp(`#\\s*${'no' + 'sec'}\\b`, 'i');
  const directive = new RegExp(`#\\s*${'no' + 'sec'}\\s+([A-Z]\\d{3})\\s*$`, 'i');
  for (const { file, content } of sources) {
    content.split(/\r?\n/).forEach((line, index) => {
      if (!marker.test(line)) return;
      const match = line.match(directive);
      if (!match) throw new Error(`Bare/malformed Bandit suppression: ${file}:${index + 1}`);
      actual.push({ file, line: index + 1, check_id: match[1].toUpperCase() });
    });
  }
  const approvedLocations = APPROVED_BANDIT_EXCEPTIONS.map(({ file, line, check_id }) => ({
    file,
    line,
    check_id,
  }));
  if (canonical(actual) !== canonical(approvedLocations)) {
    throw new Error('Bandit source suppressions differ from the two reviewed test-only exceptions');
  }
}

export function validateBanditExceptionPolicy(exceptions) {
  requireExactPolicy(exceptions, APPROVED_BANDIT_EXCEPTIONS, 'Bandit');
}

export function validateCheckovExceptionPolicy(exceptions) {
  requireExactPolicy(exceptions, APPROVED_CHECKOV_EXCEPTIONS, 'Checkov');
}
