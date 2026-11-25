import {
  validateBanditExceptionPolicy,
  validateCheckovExceptionPolicy,
} from './scanner-policy.mjs';

function requireCondition(condition, message) {
  if (!condition) throw new Error(message);
}

function array(value, label) {
  requireCondition(Array.isArray(value), `Invalid scanner report: missing ${label} array`);
  return value;
}

function number(value, label) {
  requireCondition(
    Number.isInteger(value) && value >= 0,
    `Invalid scanner report: missing ${label} count`,
  );
  return value;
}

/** A zero exit status alone does not establish that a scanner examined source. */
export function validateReport(
  tool,
  report,
  status,
  exceptions = [],
  expectedFiles = [],
  options = {},
) {
  requireCondition(status === 0, `${tool} failed with status ${status}`);
  if (tool === 'gitleaks') {
    requireCondition(array(report, 'Gitleaks findings').length === 0, 'Gitleaks findings detected');
    return;
  }
  requireCondition(
    report && typeof report === 'object' && !Array.isArray(report),
    'Invalid scanner report',
  );
  if (tool === 'lychee') {
    requireCondition(number(report.total, 'total links') > 0, 'Empty Lychee report');
    requireCondition(number(report.successful, 'successful links') > 0, 'No successful Lychee links');
    for (const field of ['unknown', 'unsupported', 'timeouts', 'errors']) {
      requireCondition(number(report[field], field) === 0, `Lychee ${field} detected`);
    }
    for (const field of ['error_map', 'timeout_map']) {
      requireCondition(
        report[field] &&
          typeof report[field] === 'object' &&
          !Array.isArray(report[field]) &&
          Object.keys(report[field]).length === 0,
        `Invalid/failing Lychee report ${field}`,
      );
    }
    const excluded = number(report.excludes, 'excluded links');
    const excludedMap = report.excluded_map;
    requireCondition(
      excludedMap && typeof excludedMap === 'object' && !Array.isArray(excludedMap),
      'Invalid/failing Lychee report excluded_map',
    );
    if (options.offlineExternalExclusions) {
      const entries = Object.values(excludedMap).flat();
      requireCondition(
        entries.length === excluded,
        'Lychee excluded-link count differs from excluded_map',
      );
      for (const entry of entries) {
        requireCondition(
          entry &&
            typeof entry === 'object' &&
            typeof entry.url === 'string' &&
            /^(?:https?:\/\/|mailto:)/i.test(entry.url),
          'Offline Lychee excluded a non-external link',
        );
      }
    } else {
      requireCondition(excluded === 0, 'Lychee exclusions detected');
      requireCondition(
        Object.keys(excludedMap).length === 0,
        'Invalid/failing Lychee report excluded_map',
      );
    }
    return;
  }
  if (tool === 'bandit' || tool === 'semgrep') {
    requireCondition(
      array(report.errors, 'errors').length === 0,
      `${tool} report contains parser/errors`,
    );
    requireCondition(array(report.results, 'results').length === 0, `${tool} findings detected`);
    if (tool === 'bandit') {
      validateBanditExceptionPolicy(exceptions);
      requireCondition(
        number(report.metrics?._totals?.loc, 'LOC') > 0,
        'Bandit report has empty scan/LOC',
      );
      requireCondition(
        number(report.metrics?._totals?.nosec, 'bare nosec') === 0,
        'Bare Bandit nosec suppressions detected',
      );
      requireCondition(
        number(report.metrics?._totals?.skipped_tests, 'skipped tests') === exceptions.length,
        'Bandit skipped-test count differs from reviewed exceptions',
      );
      for (const exception of exceptions) {
        const metrics =
          report.metrics?.[exception.file] ?? report.metrics?.[`./${exception.file}`];
        requireCondition(metrics, `Bandit report lacks metrics for ${exception.file}`);
        const expected = exceptions.filter((entry) => entry.file === exception.file).length;
        requireCondition(
          number(metrics.skipped_tests, `${exception.file} skipped tests`) === expected,
          `Bandit skipped tests differ from reviewed exceptions for ${exception.file}`,
        );
      }
    } else {
      requireCondition(
        array(report.skipped_rules, 'skipped rules').length === 0,
        'Semgrep skipped rules detected',
      );
      requireCondition(
        array(report.paths?.scanned, 'scanned files').length > 0,
        'Semgrep report has an empty scanned-file set',
      );
      for (const file of expectedFiles) {
        requireCondition(
          report.paths.scanned.includes(file),
          `Semgrep coverage has an unscanned source file: ${file}`,
        );
      }
    }
    return;
  }
  requireCondition(tool === 'checkov', `Unknown scanner report: ${tool}`);
  validateCheckovExceptionPolicy(exceptions);
  requireCondition(report.check_type === 'terraform', 'Invalid Checkov report: expected Terraform');
  const { results, summary } = report;
  requireCondition(results && summary, 'Invalid Checkov report: missing results/summary');
  for (const [field, count] of [
    ['passed_checks', 'passed'],
    ['failed_checks', 'failed'],
    ['skipped_checks', 'skipped'],
    ['parsing_errors', 'parsing_errors'],
  ]) {
    requireCondition(
      array(results[field], field).length === number(summary[count], count),
      `Checkov report summary disagrees with ${field}`,
    );
  }
  requireCondition(
    number(summary.resource_count, 'resource count') > 0,
    'Checkov report has an empty resource set',
  );
  requireCondition(summary.passed > 0, 'Checkov report has no evaluated checks');
  requireCondition(summary.failed === 0, 'Checkov findings detected');
  requireCondition(summary.parsing_errors === 0, 'Checkov parser errors detected');
  const unused = new Set(exceptions.map((_, index) => index));
  for (const skip of results.skipped_checks) {
    const index = exceptions.findIndex(
      (exception) =>
        exception.check_id === skip.check_id &&
        exception.resource === skip.resource &&
        `/${exception.file}` === skip.file_path &&
        skip.check_result?.result === 'SKIPPED' &&
        exception.rationale === skip.check_result?.suppress_comment &&
        exception.rationale.length >= 20,
    );
    requireCondition(
      index >= 0 && unused.has(index),
      `Undocumented/duplicate Checkov skip: ${skip.check_id} ${skip.resource}`,
    );
    unused.delete(index);
  }
  requireCondition(unused.size === 0, 'Unused Checkov exceptions: remove stale skip documentation');
}
