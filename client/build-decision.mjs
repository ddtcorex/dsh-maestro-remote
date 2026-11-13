/**
 * What the login bundle build does when no DeepSeek Harness checkout exists.
 *
 * client/login.js and client/login.css are build artifacts and are gitignored, so a
 * skipped build ships no login bundle at all and the native form covers the
 * sign-in page. The skip is not silent any more: it prints the impact, and a
 * required build (release, or REQUIRE_LOGIN_BUNDLE=1) fails instead of shipping
 * a package with no bundle.
 */
export function skipDecision({ packageRoot, required }) {
  const message =
    `login bundle: NOT rebuilt, no DeepSeek Harness checkout found (searched ancestors of ${packageRoot}). ` +
    'No login bundle will ship; the native sign-in form covers it. Set DSH_REPO to build it.'
  if (required) {
    return { exitCode: 1, stream: 'stderr', message: `${message} A required build cannot ship without the bundle.` }
  }
  return { exitCode: 0, stream: 'stderr', message }
}
