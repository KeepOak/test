/** A query-time measurement, without a sampler or resident timer. Workers and shell windows are separate processes. */
export function gatewayResources() {
  const memory = process.memoryUsage(), usage = process.resourceUsage();
  return {
    measuredAt: new Date().toISOString(),
    scope: process.versions.electron ? "resident desktop broker process" : "gateway process",
    excludes: ["worker engine", "shell windows"],
    pid: process.pid,
    uptimeSeconds: process.uptime(),
    memory: { rssBytes: memory.rss, peakRssBytes: usage.maxRSS * 1024,
      heapUsedBytes: memory.heapUsed, heapTotalBytes: memory.heapTotal, externalBytes: memory.external },
    // Cumulative CPU since this process began, in microseconds; this is not a sampled utilisation percentage.
    cpu: { userMicroseconds: usage.userCPUTime, systemMicroseconds: usage.systemCPUTime },
  };
}
