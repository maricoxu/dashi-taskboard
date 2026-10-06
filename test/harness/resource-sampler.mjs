import os from "node:os";
import { execFileSync } from "node:child_process";

function gpuMemorySnapshot() {
  if (process.platform === "linux") {
    try {
      const output = execFileSync("nvidia-smi", ["--query-gpu=memory.used", "--format=csv,noheader,nounits"], {
        encoding: "utf8",
        timeout: 1_000,
        stdio: ["ignore", "pipe", "ignore"],
      });
      const values = output.trim().split(/\s+/).map(Number).filter(Number.isFinite);
      return values.length > 0
        ? { source: "nvidia-smi", memoryBytes: Math.max(...values) * 1024 * 1024 }
        : { source: "unavailable", memoryBytes: null };
    } catch {}
  }
  return { source: "unavailable-on-platform", memoryBytes: null };
}

export function sampleProcessResources() {
  const memory = process.memoryUsage();
  return {
    at: new Date().toISOString(),
    rssBytes: memory.rss,
    heapUsedBytes: memory.heapUsed,
    externalBytes: memory.external,
    loadAverage: os.loadavg(),
    cpuCount: os.cpus().length,
    gpu: gpuMemorySnapshot(),
  };
}

export class ResourceSampler {
  constructor() {
    this.samples = [];
  }

  sample() {
    const value = sampleProcessResources();
    this.samples.push(value);
    return value;
  }

  report() {
    const rss = this.samples.map((sample) => sample.rssBytes);
    const heap = this.samples.map((sample) => sample.heapUsedBytes);
    return {
      sampleCount: this.samples.length,
      rssStartBytes: rss[0] ?? 0,
      rssPeakBytes: rss.length ? Math.max(...rss) : 0,
      rssEndBytes: rss.at(-1) ?? 0,
      heapPeakBytes: heap.length ? Math.max(...heap) : 0,
      gpu: this.samples.at(-1)?.gpu ?? { source: "unavailable", memoryBytes: null },
    };
  }
}
