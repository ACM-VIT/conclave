const flattenErrorMessages = (error) => {
  if (!error) return [];
  if (error instanceof AggregateError) {
    return error.errors.flatMap(flattenErrorMessages);
  }
  return [error instanceof Error ? error.message : String(error)];
};

const snapshotIsSilent = (snapshot) =>
  snapshot?.safe === true &&
  snapshot?.immutableGuardsIntact === true &&
  snapshot?.captureGuardsIntact === true &&
  snapshot?.trustedBootstrapsIntact === true &&
  snapshot?.trustedCaptureAuditIntact === true &&
  snapshot?.trustedSyntheticZeroAudioConfigured === true &&
  snapshot?.zeroAudioOnly === true &&
  snapshot?.hardwareCaptureAllowed === false;

export const summarizeSilentBrowserStart = (browser) => {
  const authority = browser?.silentAuthority ?? null;
  const aboutBlankBootstrap = browser?.silentBootstrap ?? null;
  const navigationAttestation = browser?.navigationSafety ?? null;
  const authoritySafe =
    Number.isInteger(authority?.childPid) &&
    authority.childPid > 0 &&
    authority.exactHeadless === true &&
    authority.muted === true &&
    authority.zeroAudioInput === true &&
    authority.isolatedProfile === true;
  const safe =
    authoritySafe &&
    snapshotIsSilent(aboutBlankBootstrap) &&
    snapshotIsSilent(navigationAttestation);

  return {
    label: browser?.label ?? "browser",
    authority: {
      childPid: authority?.childPid ?? null,
      exactHeadless: authority?.exactHeadless === true,
      muted: authority?.muted === true,
      zeroAudioInput: authority?.zeroAudioInput === true,
      isolatedProfile: authority?.isolatedProfile === true,
      stdioPolicy: "ignored",
    },
    aboutBlankBootstrap,
    navigationAttestation,
    safe,
  };
};

const closeOneBrowser = async (
  browser,
  { attempts, closeBrowserImpl, sleepImpl },
) => {
  let result = null;
  const errors = [];
  let attemptCount = 0;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    attemptCount = attempt;
    try {
      result = await closeBrowserImpl(browser);
      break;
    } catch (error) {
      errors.push(...flattenErrorMessages(error));
      result = error?.result ?? browser?.cleanupResult ?? result;
      if (result?.cleanupAuthorityRetained !== true) break;
      if (attempt < attempts) await sleepImpl(25);
    }
  }

  return {
    label: browser?.label ?? result?.label ?? "browser",
    attempts: attemptCount,
    finalAttestation: result?.finalAttestation ?? null,
    processTerminated: result?.processTerminated === true,
    profileRemoved: result?.profileRemoved === true,
    cleanupAuthorityReleased:
      result?.cleanupAuthorityRetained === false,
    errors,
    safe:
      result?.finalAttestation?.ok === true &&
      result?.processTerminated === true &&
      result?.profileRemoved === true &&
      result?.cleanupAuthorityRetained === false,
  };
};

export const assessSilentBrowserLifecycle = ({
  starts,
  cleanups,
  expectedBrowserCount = null,
}) => {
  const startEvidence = Array.from(starts ?? []);
  const cleanupEvidence = Array.from(cleanups ?? []);
  if (
    expectedBrowserCount !== null &&
    (!Number.isInteger(expectedBrowserCount) || expectedBrowserCount <= 0)
  ) {
    throw new TypeError("expectedBrowserCount must be a positive integer");
  }
  const resolvedExpectedBrowserCount =
    expectedBrowserCount ?? startEvidence.length;
  const complete =
    resolvedExpectedBrowserCount > 0 &&
    startEvidence.length === resolvedExpectedBrowserCount &&
    cleanupEvidence.length === resolvedExpectedBrowserCount;
  const hasStartEvidence = startEvidence.length > 0;
  const observedCleanupComplete =
    hasStartEvidence && cleanupEvidence.length === startEvidence.length;
  const exactHeadless = hasStartEvidence && startEvidence.every(
    (entry) => entry.authority?.exactHeadless === true,
  );
  const chromeMuted = hasStartEvidence && startEvidence.every(
    (entry) => entry.authority?.muted === true,
  );
  const zeroAudioInput = hasStartEvidence && startEvidence.every(
    (entry) => entry.authority?.zeroAudioInput === true,
  );
  const isolatedProfiles = hasStartEvidence && startEvidence.every(
    (entry) => entry.authority?.isolatedProfile === true,
  );
  const pageAudioOutputSuppressed = hasStartEvidence && startEvidence.every(
    (entry) =>
      snapshotIsSilent(entry.aboutBlankBootstrap) &&
      snapshotIsSilent(entry.navigationAttestation),
  );
  const hardwareCaptureBlocked = hasStartEvidence && startEvidence.every(
    (entry) =>
      entry.aboutBlankBootstrap?.hardwareCaptureAllowed === false &&
      entry.navigationAttestation?.hardwareCaptureAllowed === false,
  );
  const finalAttestationsPassed = observedCleanupComplete && cleanupEvidence.every(
    (entry) => entry.finalAttestation?.ok === true,
  );
  const processesTerminated = observedCleanupComplete && cleanupEvidence.every(
    (entry) => entry.processTerminated === true,
  );
  const profilesRemoved = observedCleanupComplete && cleanupEvidence.every(
    (entry) => entry.profileRemoved === true,
  );
  const cleanupAuthorityReleased = observedCleanupComplete && cleanupEvidence.every(
    (entry) => entry.cleanupAuthorityReleased === true,
  );
  const safe =
    complete &&
    startEvidence.every((entry) => entry.safe === true) &&
    cleanupEvidence.every((entry) => entry.safe === true) &&
    exactHeadless &&
    chromeMuted &&
    zeroAudioInput &&
    isolatedProfiles &&
    pageAudioOutputSuppressed &&
    hardwareCaptureBlocked &&
    finalAttestationsPassed &&
    processesTerminated &&
    profilesRemoved &&
    cleanupAuthorityReleased;

  return {
    safe,
    browserCount: startEvidence.length,
    expectedBrowserCount: resolvedExpectedBrowserCount,
    complete,
    exactHeadless,
    chromeMuted,
    zeroAudioInput,
    isolatedProfiles,
    pageAudioOutputSuppressed,
    hardwareCaptureBlocked,
    finalAttestationsPassed,
    processesTerminated,
    profilesRemoved,
    cleanupAuthorityReleased,
    stdioPolicy: "ignored",
    starts: startEvidence,
    cleanups: cleanupEvidence,
  };
};

export const closeBrowsersWithLifecycleEvidence = async (
  browsers,
  {
    attempts = 3,
    expectedBrowserCount = null,
    closeBrowserImpl,
    sleepImpl = (milliseconds) =>
      new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds)),
  } = {},
) => {
  if (!Number.isInteger(attempts) || attempts <= 0) {
    throw new TypeError("attempts must be a positive integer");
  }
  if (typeof closeBrowserImpl !== "function") {
    throw new TypeError("closeBrowserImpl is required");
  }
  const uniqueBrowsers = Array.from(new Set((browsers ?? []).filter(Boolean)));
  const starts = uniqueBrowsers.map(summarizeSilentBrowserStart);
  const cleanupByBrowser = new Map();
  for (const browser of [...uniqueBrowsers].reverse()) {
    cleanupByBrowser.set(
      browser,
      await closeOneBrowser(browser, {
        attempts,
        closeBrowserImpl,
        sleepImpl,
      }),
    );
  }
  const cleanups = uniqueBrowsers.map((browser) => cleanupByBrowser.get(browser));
  return assessSilentBrowserLifecycle({
    starts,
    cleanups,
    expectedBrowserCount,
  });
};
