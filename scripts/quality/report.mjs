const formatNumber = (value, digits = 1) =>
  typeof value === "number" && Number.isFinite(value)
    ? value.toFixed(digits)
    : "n/a";

const formatPercent = (value) =>
  typeof value === "number" && Number.isFinite(value)
    ? `${(value * 100).toFixed(2)}%`
    : "n/a";

const formatBitrate = (value) =>
  typeof value === "number" && Number.isFinite(value)
    ? `${Math.round(value / 1000)} kbps`
    : "n/a";

const formatGpuIdentity = (devices) => {
  const values = (Array.isArray(devices) ? devices : []).map((device) => {
    const vendor = device?.vendorString ?? device?.vendorId ?? "unknown-vendor";
    const model = device?.deviceString ?? device?.deviceId ?? "unknown-device";
    return `${vendor}/${model}`;
  });
  return values.length > 0 ? values.join(", ") : "missing";
};

export function buildRunMarkdown(result) {
  const { profile, scoring, measurement } = result;
  const receivers = Array.isArray(measurement.receivers)
    ? measurement.receivers
    : [];
  const measuredReceiverCount =
    result.receiverCount ?? measurement.receiverCount ?? 1;
  const requireUdp =
    result.environment?.runtimeParameters?.requireUdp ??
    result.requireUdp ??
    false;
  const selectedTransport =
    measurement.rtc?.selectedCandidatePairProtocol ?? "unknown";
  const sourcePerformance =
    measurement.publisher?.fixture?.end?.performance ?? null;
  const performance = scoring.performance ?? measurement.performance ?? null;
  const publisherCodecPerformance = performance?.publisher ?? null;
  const publisherProcessPerformance = performance?.browserProcesses?.find(
    (process) => process?.role === "publisher",
  );
  const primaryVisualProcessPerformance =
    performance?.browserProcesses?.find(
      (process) => process?.role === "primary-visual-receiver",
    );
  const passiveProcessPerformances =
    performance?.browserProcesses?.filter(
      (process) => process?.role === "passive-telemetry-receiver",
    ) ?? [];
  const publisherBandwidth = scoring.publisherBandwidth ?? null;
  const dynamicNetworkTransition = measurement.dynamicNetworkTransition ?? null;
  const dynamicNetworkAssessment =
    measurement.dynamicNetworkTransitionAssessment ?? null;
  const status =
    result.valid === false ? "INVALID" : scoring.passed ? "PASS" : "FAIL";
  const receiverTelemetryLines =
    receivers.length === 0
      ? []
      : [
          "## Receiver telemetry",
          "",
          "Every row is independently bound and gated. The primary runs visual analysis; passive receivers retain compositor cadence, marker latency, epoch-aligned 500 ms RTP/path/playout evidence, and an in-window terminal boundary capture without visual workers or full-frame copies.",
          "",
          "| Receiver | Profile / mode | Result | Connection / exact path | Resolution / FPS | p95 / max gap | Freeze / drop / loss | Buffer avg / p95 | Capture→display p95 / max | Bitrate |",
          "| --- | --- | --- | --- | --- | --- | --- | --- | --- | ---: |",
          ...receivers.map((receiver) => {
            const assessment = receiver.assessment ?? {};
            const metrics = assessment.metrics ?? {};
            const receiverStatus =
              assessment.valid !== true
                ? "INVALID"
                : assessment.passed === true
                  ? "PASS"
                  : "FAIL";
            const exactPath = receiver.binding?.valid === true
              ? "bound"
              : "invalid";
            const statsWindow =
              receiver.peerConnectionStats?.start &&
              receiver.peerConnectionStats?.end
                ? "start→end"
                : "stats missing";
            return `| ${receiver.label ?? `receiver-${(receiver.index ?? 0) + 1}`} | ${receiver.profile?.name ?? "unknown"} / ${receiver.mode ?? "missing"} | ${receiverStatus} | ${receiver.connection?.finalState ?? "unknown"} / ${exactPath} (${statsWindow}) | ${receiver.renderedVideo?.width ?? "?"}×${receiver.renderedVideo?.height ?? "?"} / ${formatNumber(metrics.decodedFps)} | ${formatNumber(metrics.p95FrameGapMs)} / ${formatNumber(metrics.maximumFrameGapMs)} ms | ${formatPercent(metrics.freezeRatio)} / ${formatPercent(metrics.droppedRatio)} / ${formatPercent(metrics.packetLossRatio)} | ${formatNumber(metrics.jitterBufferDelayMsPerFrame)} / ${formatNumber(metrics.jitterBufferP95MsPerFrame)} ms | ${formatNumber(metrics.captureToDisplayP95Ms)} / ${formatNumber(metrics.captureToDisplayMaximumMs)} ms | ${formatBitrate(metrics.bitrateBps)} |`;
          }),
          "",
          `Shared publisher source evidence: ${receivers.every((receiver) => receiver.sourceEvidenceReference === "measurement.publisher.fixture.captureToDisplaySource") ? "referenced by every receiver" : "missing for one or more receivers"}.`,
          "",
        ];
  const dynamicNetworkLines =
    result.runMode !== "dynamic-network-transition"
      ? []
      : [
          "## Dynamic network transition (schema 13)",
          "",
          "One immutable 103 s all-modern VP9/UDP window uses a shared future epoch: receiver-only impairment at 12 s, publisher impairment at 24 s, clear at 36 s, and recovered steady-state scoring at 91–103 s.",
          "",
          `- Authority: ${dynamicNetworkAssessment?.valid === true ? "valid" : "INVALID"}; controller failures ${(dynamicNetworkTransition?.controllerFailures ?? []).length}; ${dynamicNetworkTransition?.sampler?.checkpoints?.length ?? 0} synchronized 500 ms checkpoints.`,
          `- Receiver isolation: ${dynamicNetworkAssessment?.transitionProofs?.receiverIsolation?.passed ? "PASS" : "FAIL"} (${formatNumber(dynamicNetworkAssessment?.transitionProofs?.receiverIsolation?.startOffsetMs, 0)}–${formatNumber(dynamicNetworkAssessment?.transitionProofs?.receiverIsolation?.endOffsetMs, 0)} ms).`,
          `- Publisher downshift: ${dynamicNetworkAssessment?.transitionProofs?.downshift?.passed ? "PASS" : "FAIL"} (${formatNumber(dynamicNetworkAssessment?.transitionProofs?.downshift?.startOffsetMs, 0)}–${formatNumber(dynamicNetworkAssessment?.transitionProofs?.downshift?.endOffsetMs, 0)} ms).`,
          `- Full recovery: ${dynamicNetworkAssessment?.transitionProofs?.recoveryFull?.passed ? "PASS" : "FAIL"} (${formatNumber(dynamicNetworkAssessment?.transitionProofs?.recoveryFull?.startOffsetMs, 0)}–${formatNumber(dynamicNetworkAssessment?.transitionProofs?.recoveryFull?.endOffsetMs, 0)} ms).`,
          `- Fixed media paths: publisher sender plus exact receiver connection/stat/SSRC/consumer identities must remain unchanged; replacement is invalid.`,
          `- Shaping authority: acknowledged CDP rule IDs plus byte throughput on fixed UDP paths; publisher-upload delivery is proven at both downstream receivers because sender outbound-RTP bytes are pre-network attempts. RTC RTT/loss fields are diagnostic only. Counter windows: baseline ${dynamicNetworkTransition?.networkRealization?.baseline?.counterStartScheduledOffsetMs ?? "?"}–${dynamicNetworkTransition?.networkRealization?.baseline?.counterEndScheduledOffsetMs ?? "?"} ms; receiver-limited ${dynamicNetworkTransition?.networkRealization?.receiverLimited?.counterStartScheduledOffsetMs ?? "?"}–${dynamicNetworkTransition?.networkRealization?.receiverLimited?.counterEndScheduledOffsetMs ?? "?"} ms; publisher-limited ${dynamicNetworkTransition?.networkRealization?.publisherLimited?.counterStartScheduledOffsetMs ?? "?"}–${dynamicNetworkTransition?.networkRealization?.publisherLimited?.counterEndScheduledOffsetMs ?? "?"} ms; recovered ${dynamicNetworkTransition?.networkRealization?.recovered?.counterStartScheduledOffsetMs ?? "?"}–${dynamicNetworkTransition?.networkRealization?.recovered?.counterEndScheduledOffsetMs ?? "?"} ms. Counter baselines are strictly inside acknowledged mutation boundaries.`,
          "",
        ];
  const lines = [
    `# Conclave video quality — ${profile.name}`,
    "",
    `**${status} · ${scoring.grade} · ${formatNumber(scoring.score)} / 100**`,
    "",
    profile.description,
    "",
    `Codec scenario: \`${result.codecScenario ?? "unspecified"}\` · ${measurement.codecNegotiation?.passed ? "verified" : "failed"}`,
    `Run mode: \`${result.runMode ?? "missing"}\`${result.dynamicNetworkTransitionSchemaVersion ? ` · transition schema ${result.dynamicNetworkTransitionSchemaVersion}` : ""}`,
    `Receivers: ${measuredReceiverCount} (1 visual, ${Math.max(0, measuredReceiverCount - 1)} passive telemetry)`,
    `ICE transport: \`${selectedTransport}\` · ${requireUdp ? "UDP required" : "transport agnostic"}`,
    `Measurement contract: \`${result.measurementContractId ?? "missing"}\``,
    `Hardware identity: \`${result.environment?.hardwareIdentityId ?? performance?.hardwareIdentityId ?? "missing"}\``,
    "",
    "| Dimension | Score | Key measurement |",
    "| --- | ---: | --- |",
    `| Visual fidelity | ${formatNumber(scoring.visual.score)} | mean / worst-decile multiscale SSIM ${formatNumber(scoring.visual.multiScaleSsim, 4)} / ${formatNumber(scoring.visual.p10MultiScaleSsim, 4)}, luma PSNR ${formatNumber(scoring.visual.psnrDb)} dB |`,
    `| Motion | ${formatNumber(scoring.motion.score)} | ${formatNumber(scoring.motion.decodedFps)} delivered fps (${scoring.motion.frameRateSource ?? "unknown source"}), freeze ${formatPercent(scoring.motion.freezeRatio)} (${scoring.motion.freezeEvidenceSource ?? "unknown evidence"}), p95 visible gap ${formatNumber(scoring.motion.p95FrameGapMs)} ms |`,
    `| Capture-to-display latency | — | p50 / nearest-rank p95 / maximum ${formatNumber(scoring.captureToDisplayLatency?.p50Ms, 2)} / ${formatNumber(scoring.captureToDisplayLatency?.p95Ms, 2)} / ${formatNumber(scoring.captureToDisplayLatency?.maximumMs, 2)} ms |`,
    `| Bandwidth efficiency | ${formatNumber(scoring.efficiency.score)} | ${formatBitrate(scoring.efficiency.averageVideoBitrateBps)}, ${formatNumber(scoring.efficiency.qualityPerMbps, 3)} quality/Mbps |`,
    `| Reliability | ${formatNumber(scoring.reliability.score)} | loss ${formatPercent(scoring.reliability.packetLossRatio)}, jitter-buffer full-window average / ${formatNumber(scoring.reliability.jitterBufferDelayIntervalCoverage?.observationIntervalMs, 0)} ms interval-average p95 ${formatNumber(scoring.reliability.jitterBufferDelayMsPerFrame, 2)} / ${formatNumber(scoring.reliability.jitterBufferDelayIntervals?.p95MsPerFrame, 2)} ms (${formatNumber(scoring.reliability.maximumJitterBufferDelayMsPerFrame, 0)} ms budget), ${scoring.reliability.consoleErrorCount} browser errors |`,
    `| Compute performance | gated | encode mean / nearest-rank p95 / max ${formatNumber(publisherCodecPerformance?.timing?.intervalMeanMsPerFrame, 2)} / ${formatNumber(publisherCodecPerformance?.timing?.intervalP95MsPerFrame, 2)} / ${formatNumber(publisherCodecPerformance?.timing?.intervalMaximumMsPerFrame, 2)} ms/frame; publisher CPU avg / p95 / max ${formatNumber(publisherProcessPerformance?.coreEquivalents, 2)} / ${formatNumber(publisherProcessPerformance?.p95CoreEquivalents, 2)} / ${formatNumber(publisherProcessPerformance?.maximumObservedCoreEquivalents, 2)} cores |`,
    "",
    ...receiverTelemetryLines,
    ...dynamicNetworkLines,
    "## Compute and codec performance",
    "",
    "Codec observations are token-bound and contained inside the shared measurement window, using absolute 500 ms targets plus an in-window terminal boundary capture. Continuous browser-level CDP process polling uses absolute 500 ms targets at both shared-window boundaries, rejects lifecycle/cadence gaps, and reports CPU only from complete counter intervals without boundary clipping.",
    "",
    "| Endpoint | Codec cost mean / p95 / max | Implementation / power efficient | QP | Process CPU / gate |",
    "| --- | --- | --- | --- | --- |",
    `| Publisher | ${formatNumber(publisherCodecPerformance?.timing?.intervalMeanMsPerFrame, 2)} / ${formatNumber(publisherCodecPerformance?.timing?.intervalP95MsPerFrame, 2)} / ${formatNumber(publisherCodecPerformance?.timing?.intervalMaximumMsPerFrame, 2)} ms encode/frame | ${(publisherCodecPerformance?.metadata?.implementations ?? []).join(", ") || publisherCodecPerformance?.metadata?.implementationAuthority || "missing"} / ${String(publisherCodecPerformance?.metadata?.powerEfficient?.[0] ?? publisherCodecPerformance?.metadata?.powerEfficientAuthority ?? "missing")} | ${publisherCodecPerformance?.timing?.qp?.authority ?? "missing"}: ${formatNumber(publisherCodecPerformance?.timing?.qp?.fullWindowAverage, 2)} | avg / p95 / max ${formatNumber(publisherProcessPerformance?.coreEquivalents, 3)} / ${formatNumber(publisherProcessPerformance?.p95CoreEquivalents, 3)} / ${formatNumber(publisherProcessPerformance?.maximumObservedCoreEquivalents, 3)}; avg gate ${formatNumber(publisherProcessPerformance?.maximumCoreEquivalents, 3)} cores |`,
    ...receivers.map((receiver, index) => {
      const codec = performance?.receivers?.[index] ?? receiver.codecPerformance;
      const process = performance?.browserProcesses?.find(
        (entry) => entry?.label === receiver.label,
      );
      return `| ${receiver.label ?? `receiver-${index + 1}`} (${receiver.mode ?? "missing"}) | ${formatNumber(codec?.timing?.intervalMeanMsPerFrame, 2)} / ${formatNumber(codec?.timing?.intervalP95MsPerFrame, 2)} / ${formatNumber(codec?.timing?.intervalMaximumMsPerFrame, 2)} ms decode/frame | ${codec?.metadata?.decoderImplementation ?? codec?.metadata?.decoderImplementationAuthority ?? "missing"} / ${String(codec?.metadata?.powerEfficientDecoder ?? codec?.metadata?.powerEfficientDecoderAuthority ?? "missing")} | ${codec?.timing?.qp?.authority ?? "missing"}: ${formatNumber(codec?.timing?.qp?.fullWindowAverage, 2)} | avg / p95 / max ${formatNumber(process?.coreEquivalents, 3)} / ${formatNumber(process?.p95CoreEquivalents, 3)} / ${formatNumber(process?.maximumObservedCoreEquivalents, 3)}; avg gate ${formatNumber(process?.maximumCoreEquivalents, 3)} cores |`;
    }),
    "",
    `- Publisher CPU quality limitation: ${formatPercent(publisherCodecPerformance?.qualityLimitations?.cpuRatio)} observed / ${formatPercent(publisherCodecPerformance?.qualityLimitations?.maximumCpuRatio)} maximum; durations ${JSON.stringify(publisherCodecPerformance?.qualityLimitations?.durationsSeconds ?? {})}`,
    `- Publisher process CPU by type: ${JSON.stringify(publisherProcessPerformance?.cpuSecondsByType ?? {})} CPU-seconds across ${formatNumber(publisherProcessPerformance?.coveredDurationMs, 1)} ms of complete boundary-targeted intervals (${formatPercent(publisherProcessPerformance?.coverageRatio)} capture-envelope/window ratio); interval p95 / maximum ${formatNumber(publisherProcessPerformance?.p95CoreEquivalents, 3)} / ${formatNumber(publisherProcessPerformance?.maximumObservedCoreEquivalents, 3)} cores.`,
    `- Every Chrome process breakdown: ${(performance?.browserProcesses ?? []).map((process) => `${process.label} ${formatNumber(process.coreEquivalents, 3)} cores ${JSON.stringify(process.cpuSecondsByType ?? {})}`).join("; ") || "missing"}.`,
    `- Primary visual observer process: ${formatNumber(primaryVisualProcessPerformance?.coreEquivalents, 3)} cores, including the separately gated sampler work reported below.`,
    `- Passive telemetry process maximum: ${formatNumber(Math.max(...passiveProcessPerformances.map((entry) => entry.coreEquivalents).filter(Number.isFinite)), 3)} cores across ${passiveProcessPerformances.length} passive receiver(s).`,
    `- Hardware binding: ${performance?.hardwareIdentityId ?? "missing"}; platform ${result.environment?.hardwareIdentity?.platform ?? "missing"}/${result.environment?.hardwareIdentity?.architecture ?? "missing"}, OS release ${result.environment?.hardwareIdentity?.osRelease ?? "missing"}, ${result.environment?.hardwareIdentity?.logicalCpuCount ?? "?"} logical CPUs, ${result.environment?.hardwareIdentity?.memoryBucketGiB ?? "?"} GiB memory bucket, GPU ${formatGpuIdentity(result.environment?.hardwareIdentity?.gpu?.devices)}, Chrome ${result.environment?.hardwareIdentity?.chrome?.product ?? "missing"}.`,
    "",
    "## Publisher bandwidth authority",
    "",
    `- Topology: ${publisherBandwidth?.topology ?? "missing"}; aggregate ${formatBitrate(publisherBandwidth?.aggregateBitrateBps)} / ${formatBitrate(publisherBandwidth?.budget?.maximumAggregateBitrateBps)} maximum (${formatPercent(publisherBandwidth?.aggregateBudgetUtilizationRatio)} utilization).`,
    `- Quality density: ${formatNumber(publisherBandwidth?.qualityPerMbps, 4)} / ${formatNumber(publisherBandwidth?.budget?.minimumQualityPerMbps, 4)} minimum quality/Mbps.`,
    `- Exact active layer caps: ${(publisherBandwidth?.layers ?? []).map((layer) => `${layer.key} ${formatBitrate(layer.observedBitrateBps)} / ${formatBitrate(layer.configuredCapBps)} configured (${formatBitrate(layer.allowedBitrateBps)} hard allowance)`).join("; ") || "missing"}.`,
    "",
    "## Decoded media",
    "",
    `- Resolution: ${measurement.rtc?.frameWidth ?? "?"}×${measurement.rtc?.frameHeight ?? "?"}`,
    `- Codec: ${measurement.rtc?.codecMimeType ?? "unknown"}`,
    `- Decoder: ${measurement.rtc?.decoderImplementation ?? "unknown"}`,
    `- Power-efficient decoder: ${String(measurement.rtc?.powerEfficientDecoder ?? "unknown")}`,
    `- Visual comparison: multiscale Rec. 709 luma/chroma at up to ${measurement.analysis?.maximumWidth ?? "?"} px wide; only marker pixels excluded`,
    `- Scoring calibration: v${scoring.version ?? "unknown"}; equal scene weighting with 75% phase-spanning mean + 25% scene-tail fidelity`,
    `- Worst-decile fidelity: SSIM ${formatNumber(scoring.visual.p10Ssim, 4)}, PSNR ${formatNumber(scoring.visual.p10PsnrDb)} dB, edge retention ${formatPercent(scoring.visual.p10EdgeRetention)}`,
    `- Chroma fidelity: mean / p10 SSIM ${formatNumber(scoring.visual.chromaSsim, 4)} / ${formatNumber(scoring.visual.p10ChromaSsim, 4)}, mean / p10 PSNR ${formatNumber(scoring.visual.chromaPsnrDb)} / ${formatNumber(scoring.visual.p10ChromaPsnrDb)} dB, mean absolute error ${formatNumber(scoring.visual.meanAbsoluteChromaError, 3)}`,
    `- Frame-alignment canary: ${formatPercent(scoring.visual.alignmentWinRate)} current-frame wins; mean / p10 motion-weighted relative margin ${formatNumber(scoring.visual.alignmentMeanMargin, 3)} / ${formatNumber(scoring.visual.alignmentP10Margin, 3)}`,
    `- Scene scores: ${(scoring.visual.sceneScores ?? []).map((scene) => `scene ${scene.sceneId} ${formatNumber(scene.meanScore)} mean / ${formatNumber(scene.tailScore)} p10 (${scene.sampleCount} samples)`).join("; ") || "unavailable"}`,
    `- Valid visual samples: ${scoring.visual.validSampleCount}/${scoring.visual.sampleCount}`,
    `- Deterministic fixture phase coverage: ${formatPercent(scoring.visual.fixturePhaseCoverage)} (maximum gap ${scoring.visual.maximumFixturePhaseGap ?? "?"}/360 frames)`,
    `- Final media path stabilization: ${formatNumber(measurement.mediaPathStability?.waitedMs)} ms wait; ${formatNumber(measurement.mediaPathStability?.stableMs)} ms and ${measurement.mediaPathStability?.decodedFrames ?? "?"} decoded frames on one producer/consumer/codec/SSRC/layer`,
    `- Navigation to first decoded frame: ${formatNumber(scoring.startup?.navigationToFirstDecodeMs)} ms`,
    `- Navigation to target resolution: ${formatNumber(scoring.startup?.navigationToTargetMs)} ms`,
    `- Navigation startup gate: ${scoring.startup?.navigationGateEnforced ? "enforced (production server)" : "informational (development/unknown server)"}`,
    `- First decoded frame to target resolution: ${formatNumber(scoring.startup?.firstDecodeToTargetHeightMs)} ms`,
    `- Planned consumer-generation reset: ${measurement.consumerGenerationReset?.expected ? `${measurement.consumerGenerationReset?.completedEntryCount ?? 0} completed; old→new interruption ${formatNumber(measurement.consumerGenerationReset?.visibleInterruptionMs)} ms; first-decode-through-reset maximum gap ${formatNumber(measurement.consumerGenerationReset?.firstDecodeThroughResetMaximumGapMs)} / ${formatNumber(measurement.consumerGenerationReset?.maximumVisibleInterruptionMs)} ms` : "not applicable on this media path"}`,
    `- Startup presented-frame continuity: ${measurement.startup?.frameContinuity?.presentedFrameCount ?? 0} frames observed; ${measurement.startup?.frameContinuity?.consumerGenerationTransitions?.length ?? 0} consumer transition(s); longest gap ${formatNumber(measurement.startup?.frameContinuity?.longestPresentedFrameGapMs)} ms`,
    `- Resolution transitions: ${(scoring.startup?.transitions ?? []).map((transition) => `${transition.width}×${transition.height} @ ${formatNumber(transition.sinceFirstDecodeMs)} ms`).join(" → ") || "none"}`,
    `- Delivered / RTC-decoded / observed callback FPS: ${formatNumber(scoring.motion.presentedFps)} / ${formatNumber(scoring.motion.rtcDecodedFps)} / ${formatNumber(scoring.motion.callbackFps)}`,
    `- Longest visible frame gap: ${formatNumber(scoring.motion.longestGapMs)} ms`,
    `- Visible-frame p95 / maximum / profile limits: ${formatNumber(scoring.motion.p95FrameGapMs, 2)} / ${formatNumber(scoring.motion.longestGapMs, 2)} ms observed; ${formatNumber(profile.maximumP95FrameGapMs, 2)} / ${formatNumber(profile.maximumVisibleFrameGapMs, 2)} ms maximum`,
    `- Decoder dropped-frame ratio: ${formatPercent(scoring.motion.droppedRatio)} observed / ${formatPercent(profile.maximumDroppedFrameRatio)} maximum`,
    `- Longest raw JS callback gap: ${formatNumber(measurement.cadence?.longestRawCallbackGapMs)} ms`,
    `- Capture-to-display latency: mean / p50 / nearest-rank p95 / maximum ${formatNumber(scoring.captureToDisplayLatency?.meanMs, 2)} / ${formatNumber(scoring.captureToDisplayLatency?.p50Ms, 2)} / ${formatNumber(scoring.captureToDisplayLatency?.p95Ms, 2)} / ${formatNumber(scoring.captureToDisplayLatency?.maximumMs, 2)} ms; profile p95 / maximum ${formatNumber(profile.maximumCaptureToDisplayP95Ms, 0)} / ${formatNumber(profile.maximumCaptureToDisplayMs, 0)} ms`,
    `- Capture-to-display authority: ${scoring.captureToDisplayLatency?.matchedSampleCount ?? 0}/${measurement.cadence?.callbackCount ?? scoring.captureToDisplayLatency?.presentationObservationCount ?? 0} compositor callbacks (${formatPercent(scoring.captureToDisplayLatency?.sampleCoverageRatio)}), ${formatPercent(scoring.captureToDisplayLatency?.presentedFrameSampleRatio)} of presented frames sampled, temporal coverage ${formatPercent(scoring.captureToDisplayLatency?.windowCoverageRatio)}, rolling marker modulus ${scoring.captureToDisplayLatency?.markerSequenceModulus ?? "missing"}, generations ${scoring.captureToDisplayLatency?.sourceMarkerGenerationCount ?? "missing"}, ambiguous joins ${scoring.captureToDisplayLatency?.ambiguousObservationCount ?? 0}`,
    `- Receiver jitter-buffer delay: ${formatNumber(scoring.reliability.jitterBufferDelayMsPerFrame, 2)} ms/frame full-window average; ${formatNumber(scoring.reliability.jitterBufferDelayIntervalCoverage?.observationIntervalMs, 0)} ms interval-average p50 / nearest-rank p95 / maximum ${formatNumber(scoring.reliability.jitterBufferDelayIntervals?.p50MsPerFrame, 2)} / ${formatNumber(scoring.reliability.jitterBufferDelayIntervals?.p95MsPerFrame, 2)} / ${formatNumber(scoring.reliability.jitterBufferDelayIntervals?.maximumMsPerFrame, 2)} ms across ${scoring.reliability.jitterBufferDelayIntervals?.sampleCount ?? 0} samples; profile maximum ${formatNumber(scoring.reliability.maximumJitterBufferDelayMsPerFrame, 0)} ms/frame`,
    `- Jitter-buffer evidence coverage: ${formatPercent(scoring.reliability.jitterBufferDelayIntervalCoverage?.coverageRatio)} of the exact measurement window; maximum latency-evidence observation gap ${formatNumber(scoring.reliability.jitterBufferDelayIntervalCoverage?.maximumObservationIntervalMs, 2)} / ${formatNumber(scoring.reliability.jitterBufferDelayIntervalCoverage?.maximumAllowedObservationIntervalMs, 2)} ms`,
    `- Jitter-buffer latency score penalty: ${formatNumber(scoring.reliability.jitterBufferLatencyScorePenalty, 2)} points from worst full-window/interval-p95 value ${formatNumber(scoring.reliability.worstJitterBufferLatencyMs, 2)} ms`,
    `- Requested receiver jitter-buffer target: ${formatNumber(measurement.receiverPlayoutPolicy?.requestedTargetMs, 0)} ms requested / ${formatNumber(measurement.receiverPlayoutPolicy?.observedTargetMs, 0)} ms observed (${measurement.receiverPlayoutPolicy?.status ?? "missing"}); exact consumer ${measurement.receiverPlayoutPolicy?.evidencePresent ? "bound" : "missing"}`,
    `- Continuous receiver-target authority: ${scoring.reliability.receiverPlayoutPolicyObservations?.authoritativeCount ?? 0}/${scoring.reliability.receiverPlayoutPolicyObservations?.observationCount ?? 0} bound path observations; maximum requested ${formatNumber(scoring.reliability.receiverPlayoutPolicyObservations?.maximumRequestedTargetMs, 0)} ms`,
    `- Receiver jitter-buffer target / network minimum: ${formatNumber(scoring.reliability.jitterBufferTargetDelayMsPerFrame, 2)} / ${formatNumber(scoring.reliability.jitterBufferMinimumDelayMsPerFrame, 2)} ms/frame average`,
    `- Video-frame callback coverage: ${formatPercent(measurement.cadence?.videoFrameCallbackCoverage)}`,
    `- Sampler overhead: p95 main-thread work ${formatNumber(measurement.samplerOverhead?.mainThreadWorkMs?.p95, 2)} ms, p95 worker metrics ${formatNumber(measurement.samplerOverhead?.metricComputeMs?.p95, 2)} ms, main-thread duty ${formatPercent(measurement.samplerOverhead?.mainThreadDutyRatio)}, queued depth ${measurement.samplerOverhead?.pendingJobDepthMaximum ?? "?"}, skipped ${measurement.samplerOverhead?.skippedVisualSamples ?? "?"}`,
    `- Bound-path observer overhead: p95 / maximum ${formatNumber(measurement.samplerOverhead?.pathObservationMs?.p95, 2)} / ${formatNumber(measurement.samplerOverhead?.pathObservationMs?.maximum, 2)} ms, duty ${formatPercent(measurement.samplerOverhead?.pathObservationDutyRatio)}`,
    `- Source-fixture measurement window: ${formatNumber(sourcePerformance?.elapsedMs)} ms, ${sourcePerformance?.renderedFrameCount ?? "?"} rendered frames`,
    `- Source-fixture overhead: p95 / maximum render ${formatNumber(sourcePerformance?.renderDurationMs?.p95, 2)} / ${formatNumber(sourcePerformance?.renderDurationMs?.maximum, 2)} ms, maximum render interval ${formatNumber(sourcePerformance?.renderIntervalMs?.maximum, 2)} ms, render duty ${formatPercent(sourcePerformance?.renderDutyRatio)}, missed deadlines ${sourcePerformance?.missedRenderDeadlines ?? "?"}`,
    `- NACK / PLI / FIR: ${measurement.rtc?.nackCountDelta ?? 0} / ${measurement.rtc?.pliCountDelta ?? 0} / ${measurement.rtc?.firCountDelta ?? 0}`,
    `- Publisher aggregate video: ${formatBitrate(measurement.rtc?.publisherVideoBitrateBps)}`,
    `- Receiver video: ${formatBitrate(measurement.rtc?.receiverVideoBitrateBps)}`,
    `- Active publisher encodings: ${measurement.publisher?.rtc?.activeEncodingCount ?? "unknown"}`,
    `- Publisher scalability: ${
      measurement.publisher?.rtc?.encodings
        ?.filter((encoding) => encoding.active)
        .map((encoding) => encoding.scalabilityMode ?? "none")
        .join(", ") || "unknown"
    }`,
    `- Codec expectation: ${measurement.codecNegotiation?.scenario ?? "unspecified"}`,
    `- Publisher primary codec: ${measurement.codecNegotiation?.observed?.primarySenderCodec?.mimeType ?? "unknown"}${measurement.codecNegotiation?.observed?.primarySenderCodec?.sdpFmtpLine ? ` (${measurement.codecNegotiation.observed.primarySenderCodec.sdpFmtpLine})` : ""}`,
    `- Codec transition: ${measurement.codecNegotiation?.observed?.transition?.required ? `${measurement.codecNegotiation.observed.transition.initialProducerId ?? "?"} → ${measurement.codecNegotiation.observed.transition.finalProducerId ?? "?"} in ${formatNumber(measurement.codecNegotiation.observed.transition.durationMs)} ms` : "not required"}`,
    "",
  ];

  if (result.valid === false) {
    lines.push("## Invalid environment", "");
    lines.push(
      "The environment or measurement harness failed an integrity gate, so this run must not be used as a product-quality verdict.",
      "",
    );
    for (const warning of measurement.networkRealization?.warnings ?? []) {
      lines.push(`- ${warning}`);
    }
    for (const failedCheck of (
      measurement.networkRealization?.checks ?? []
    ).filter((entry) => entry.status !== "pass")) {
      lines.push(
        `- ${failedCheck.name}: ${failedCheck.status}${failedCheck.reason ? ` — ${failedCheck.reason}` : ""}`,
      );
    }
    for (const receiver of receivers.filter(
      (entry) => entry?.network?.valid !== true,
    )) {
      for (const warning of receiver.network?.warnings ?? []) {
        lines.push(`- ${receiver.label ?? "receiver"} network: ${warning}`);
      }
      for (const failedCheck of (receiver.network?.checks ?? []).filter(
        (entry) => entry.status !== "pass",
      )) {
        lines.push(
          `- ${receiver.label ?? "receiver"} network ${failedCheck.name}: ${failedCheck.status}${failedCheck.reason ? ` — ${failedCheck.reason}` : ""}`,
        );
      }
    }
    for (const failure of scoring.harnessFailures ?? []) {
      lines.push(`- Harness: ${failure}`);
    }
    lines.push("");
  }

  if ((scoring.productFailures ?? scoring.failures).length > 0) {
    lines.push("## Failed product gates", "");
    for (const failure of scoring.productFailures ?? scoring.failures) {
      lines.push(`- ${failure}`);
    }
    lines.push("");
  }

  if (result.artifacts?.worstRemoteFrame) {
    lines.push(
      "## Worst sampled frame",
      "",
      `![Worst decoded frame](${result.artifacts.worstRemoteFrame})`,
      "",
    );
  }

  if (
    result.artifacts?.p10RemoteFrame ||
    result.artifacts?.medianRemoteFrame ||
    result.artifacts?.bestRemoteFrame
  ) {
    lines.push("## Distribution audit frames", "");
    if (result.artifacts?.p10RemoteFrame) {
      lines.push(
        `![P10 decoded frame](${result.artifacts.p10RemoteFrame})`,
        "",
      );
    }
    if (result.artifacts?.medianRemoteFrame) {
      lines.push(
        `![Median decoded frame](${result.artifacts.medianRemoteFrame})`,
        "",
      );
    }
    if (result.artifacts?.bestRemoteFrame) {
      lines.push(
        `![Best decoded frame](${result.artifacts.bestRemoteFrame})`,
        "",
      );
    }
  }

  lines.push(
    "## Reproduce",
    "",
    "```bash",
    result.reproduceCommand,
    "```",
    "",
    "The harness runs Chrome headlessly with process-level audio muting and page-level output suppression.",
    "",
  );

  return lines.join("\n");
}

export function buildMatrixMarkdown(report) {
  const requireUdp =
    report.requireUdp ?? report.environment?.runtimeParameters?.requireUdp ?? false;
  const lines = [
    "# Conclave headless video-quality matrix",
    "",
    `**${report.summary.passed}/${report.summary.total} profiles passed · ${report.summary.invalid ?? 0} invalid · average ${formatNumber(report.summary.averageScore)} / 100 · minimum ${formatNumber(report.summary.minimumScore)} / 100**`,
    "",
    `Receivers per room: ${report.receiverCount ?? 1}`,
    `Ordered receiver profiles: ${(report.results?.[0]?.receiverProfiles ?? report.results?.[0]?.measurement?.networkProfiles?.receivers ?? []).join(", ") || "legacy primary-only report"}`,
    `ICE transport requirement: ${requireUdp ? "UDP required" : "transport agnostic"}`,
    `Run mode: ${report.runMode ?? "missing"}${report.dynamicNetworkTransitionSchemaVersion ? ` (transition schema ${report.dynamicNetworkTransitionSchemaVersion})` : ""}`,
    "",
    "| Profile | Codec path | Transport | Result | Score | Visual | FPS | Freeze | Buffer (full avg / interval p95) | Capture→display (p95 / max) | Publisher bandwidth / quality density | Encode p95 / worst decode p95 | Publisher / passive CPU (avg/p95/max) | Resolution | Receiver gates |",
    "| --- | --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | --- | --- | --- | --- | --- |",
  ];

  for (const result of report.results) {
    const scoring = result.scoring;
    const rtc = result.measurement.rtc ?? {};
    const status =
      result.valid === false ? "INVALID" : scoring.passed ? "PASS" : "FAIL";
    const receiverTelemetry = scoring.receiverTelemetry ?? {};
    const performance = scoring.performance ?? {};
    const worstDecodeP95 = Math.max(
      ...((performance.receivers ?? [])
        .map((receiver) => receiver?.timing?.intervalP95MsPerFrame)
        .filter(Number.isFinite)),
    );
    const publisherCpu = performance.browserProcesses?.find(
      (process) => process?.role === "publisher",
    )?.coreEquivalents;
    const publisherProcess = performance.browserProcesses?.find(
      (process) => process?.role === "publisher",
    );
    const worstPassiveCpu = Math.max(
      ...((performance.browserProcesses ?? [])
        .filter(
          (process) => process?.role === "passive-telemetry-receiver",
        )
        .map((process) => process?.coreEquivalents)
        .filter(Number.isFinite)),
    );
    const worstPassiveP95Cpu = Math.max(
      ...((performance.browserProcesses ?? [])
        .filter(
          (process) => process?.role === "passive-telemetry-receiver",
        )
        .map((process) => process?.p95CoreEquivalents)
        .filter(Number.isFinite)),
    );
    const worstPassiveMaximumCpu = Math.max(
      ...((performance.browserProcesses ?? [])
        .filter(
          (process) => process?.role === "passive-telemetry-receiver",
        )
        .map((process) => process?.maximumObservedCoreEquivalents)
        .filter(Number.isFinite)),
    );
    lines.push(
      `| ${result.profile.name} | ${result.codecScenario ?? report.codecScenario ?? "unspecified"} | ${rtc.selectedCandidatePairProtocol ?? "unknown"} | ${status} | ${formatNumber(scoring.score)} | ${formatNumber(scoring.visual.score)} | ${formatNumber(scoring.motion.decodedFps)} | ${formatPercent(scoring.motion.freezeRatio)} | ${formatNumber(scoring.reliability.jitterBufferDelayMsPerFrame, 1)}/${formatNumber(scoring.reliability.jitterBufferDelayIntervals?.p95MsPerFrame, 1)} ms | ${formatNumber(scoring.captureToDisplayLatency?.p95Ms, 1)}/${formatNumber(scoring.captureToDisplayLatency?.maximumMs, 1)} ms | ${formatBitrate(scoring.publisherBandwidth?.aggregateBitrateBps ?? scoring.efficiency.averageVideoBitrateBps)} / ${formatNumber(scoring.publisherBandwidth?.qualityPerMbps, 3)} | ${formatNumber(performance.publisher?.timing?.intervalP95MsPerFrame, 2)} / ${formatNumber(worstDecodeP95, 2)} ms | ${formatNumber(publisherCpu, 2)}/${formatNumber(publisherProcess?.p95CoreEquivalents, 2)}/${formatNumber(publisherProcess?.maximumObservedCoreEquivalents, 2)} / ${formatNumber(worstPassiveCpu, 2)}/${formatNumber(worstPassiveP95Cpu, 2)}/${formatNumber(worstPassiveMaximumCpu, 2)} cores | ${rtc.frameWidth ?? "?"}×${rtc.frameHeight ?? "?"} | ${receiverTelemetry.passedCount ?? 0}/${receiverTelemetry.expectedCount ?? result.receiverCount ?? 1} pass |`,
    );
  }

  if (report.repeatability?.some((entry) => entry.runs > 1)) {
    lines.push("", "## Repeatability", "");
    lines.push(
      "| Profile | Codec | Runs / hardware | Score range | Visual range | FPS range | Buffer full-window avg / interval-average p95 range | Capture→display p95 / max range | Encode / decode p95 range | Publisher CPU range |",
      "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    );
    for (const entry of report.repeatability.filter((item) => item.runs > 1)) {
      lines.push(
        `| ${entry.profile} | ${entry.codecScenario} | ${entry.runs} / ${entry.hardwareConsistent ? `bound ${entry.hardwareIdentityId}` : "INCOMPATIBLE"} | ${formatNumber(entry.score.minimum)}–${formatNumber(entry.score.maximum)} (Δ${formatNumber(entry.score.spread)}) | ${formatNumber(entry.visual.minimum)}–${formatNumber(entry.visual.maximum)} (Δ${formatNumber(entry.visual.spread)}) | ${formatNumber(entry.deliveredFps.minimum)}–${formatNumber(entry.deliveredFps.maximum)} (Δ${formatNumber(entry.deliveredFps.spread)}) | ${formatNumber(entry.jitterBufferAverageMs.minimum)}–${formatNumber(entry.jitterBufferAverageMs.maximum)} / ${formatNumber(entry.jitterBufferP95Ms.minimum)}–${formatNumber(entry.jitterBufferP95Ms.maximum)} ms | ${formatNumber(entry.captureToDisplayP95Ms.minimum)}–${formatNumber(entry.captureToDisplayP95Ms.maximum)} / ${formatNumber(entry.captureToDisplayMaximumMs.minimum)}–${formatNumber(entry.captureToDisplayMaximumMs.maximum)} ms | ${formatNumber(entry.publisherEncodeP95MsPerFrame?.minimum)}–${formatNumber(entry.publisherEncodeP95MsPerFrame?.maximum)} / ${formatNumber(entry.receiverDecodeP95MsPerFrame?.minimum)}–${formatNumber(entry.receiverDecodeP95MsPerFrame?.maximum)} ms | ${formatNumber(entry.publisherProcessCoreEquivalents?.minimum)}–${formatNumber(entry.publisherProcessCoreEquivalents?.maximum)} cores |`,
      );
    }
    lines.push("");
  }

  if (report.comparison) {
    lines.push("", "## Baseline comparison", "");
    if (report.comparison.incompatibleMeasurementContracts) {
      lines.push(
        `Comparison rejected: measurement contracts differ (${report.comparison.baselineMeasurementContractId ?? "missing"} → ${report.comparison.currentMeasurementContractId ?? "missing"}).`,
        "",
      );
    } else if (report.comparison.incompatibleRuntimeParameters) {
      lines.push(
        "Comparison rejected: effective runtime parameters differ.",
        "",
      );
      for (const mismatch of report.comparison.runtimeParameterMismatches ?? []) {
        const scope = mismatch.profile
          ? `${mismatch.codecScenario ?? "unspecified"}/${mismatch.profile}`
          : mismatch.scope ?? "matrix";
        lines.push(
          `- ${scope} ${mismatch.parameter}: ${JSON.stringify(mismatch.baseline)} → ${JSON.stringify(mismatch.current)}`,
        );
      }
      lines.push("");
    } else if (report.comparison.validComparison !== true) {
      lines.push(
        "Comparison rejected: the requested baseline has no valid overlapping profile for this matrix.",
      );
    } else {
      lines.push(
        `Compared ${report.comparison.comparableProfiles} profile(s) against \`${report.comparison.baselinePath}\`.`,
        "",
      );
    }
    if (report.comparison.regressions.length > 0) {
      lines.push("Regressions:", "");
      for (const regression of report.comparison.regressions) {
        lines.push(`- ${regression}`);
      }
      lines.push("");
    }
    if (report.comparison.improvements.length > 0) {
      lines.push("Improvements:", "");
      for (const improvement of report.comparison.improvements) {
        lines.push(`- ${improvement}`);
      }
      lines.push("");
    }
  }

  lines.push(
    "",
    "Each profile also has a detailed JSON and Markdown report with its failed gates and worst sampled decoded frame.",
    "",
  );
  return lines.join("\n");
}
