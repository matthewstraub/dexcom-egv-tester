import { describe, it, expect } from "vitest";

/**
 * Inline copy of splitDateRange for testing (since it's defined inside a React component file).
 * This must match the implementation in Correlations.tsx.
 */
function splitDateRange(startISO: string, endISO: string, maxDays: number = 7): Array<{ start: string; end: string }> {
  const chunks: Array<{ start: string; end: string }> = [];
  const startMs = new Date(startISO + (startISO.endsWith("Z") ? "" : "Z")).getTime();
  const endMs = new Date(endISO + (endISO.endsWith("Z") ? "" : "Z")).getTime();
  const chunkMs = maxDays * 24 * 60 * 60 * 1000;

  let cursor = startMs;
  while (cursor < endMs) {
    const chunkEnd = Math.min(cursor + chunkMs, endMs);
    const startStr = new Date(cursor).toISOString().slice(0, 19);
    const endStr = new Date(chunkEnd).toISOString().slice(0, 19);
    chunks.push({ start: startStr, end: endStr });
    cursor = chunkEnd;
  }
  return chunks;
}

describe("splitDateRange", () => {
  it("returns a single chunk for a range under maxDays", () => {
    const chunks = splitDateRange("2026-01-01T00:00:00", "2026-01-05T00:00:00", 7);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].start).toBe("2026-01-01T00:00:00");
    expect(chunks[0].end).toBe("2026-01-05T00:00:00");
  });

  it("returns a single chunk for exactly maxDays", () => {
    const chunks = splitDateRange("2026-01-01T00:00:00", "2026-01-08T00:00:00", 7);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].start).toBe("2026-01-01T00:00:00");
    expect(chunks[0].end).toBe("2026-01-08T00:00:00");
  });

  it("splits a 31-day range into 5 chunks of 7 days", () => {
    const chunks = splitDateRange("2026-01-01T00:00:00", "2026-02-01T00:00:00", 7);
    // 31 days / 7 = 4 full chunks + 1 partial = 5 chunks
    expect(chunks).toHaveLength(5);

    // First chunk: Jan 1 -> Jan 8
    expect(chunks[0].start).toBe("2026-01-01T00:00:00");
    expect(chunks[0].end).toBe("2026-01-08T00:00:00");

    // Second chunk: Jan 8 -> Jan 15
    expect(chunks[1].start).toBe("2026-01-08T00:00:00");
    expect(chunks[1].end).toBe("2026-01-15T00:00:00");

    // Last chunk should end at Feb 1
    expect(chunks[chunks.length - 1].end).toBe("2026-02-01T00:00:00");
  });

  it("handles a 90-day range", () => {
    const chunks = splitDateRange("2026-01-01T00:00:00", "2026-04-01T00:00:00", 7);
    // 90 days / 7 = ~13 chunks
    expect(chunks.length).toBeGreaterThanOrEqual(12);
    expect(chunks.length).toBeLessThanOrEqual(14);

    // First chunk starts at the start date
    expect(chunks[0].start).toBe("2026-01-01T00:00:00");

    // Last chunk ends at the end date
    expect(chunks[chunks.length - 1].end).toBe("2026-04-01T00:00:00");

    // Chunks are contiguous (each chunk's end is the next chunk's start)
    for (let i = 0; i < chunks.length - 1; i++) {
      expect(chunks[i].end).toBe(chunks[i + 1].start);
    }
  });

  it("returns empty array when start equals end", () => {
    const chunks = splitDateRange("2026-01-01T00:00:00", "2026-01-01T00:00:00", 7);
    expect(chunks).toHaveLength(0);
  });

  it("returns empty array when start is after end", () => {
    const chunks = splitDateRange("2026-02-01T00:00:00", "2026-01-01T00:00:00", 7);
    expect(chunks).toHaveLength(0);
  });

  it("handles timestamps with time components", () => {
    const chunks = splitDateRange("2026-01-01T10:30:00", "2026-01-20T15:45:00", 7);
    expect(chunks).toHaveLength(3);
    expect(chunks[0].start).toContain("2026-01-01");
    expect(chunks[chunks.length - 1].end).toContain("2026-01-20");
  });

  it("handles Z-suffixed dates", () => {
    const chunks = splitDateRange("2026-01-01T00:00:00Z", "2026-01-15T00:00:00Z", 7);
    expect(chunks).toHaveLength(2);
    expect(chunks[0].start).toBe("2026-01-01T00:00:00");
    expect(chunks[0].end).toBe("2026-01-08T00:00:00");
    expect(chunks[1].start).toBe("2026-01-08T00:00:00");
    expect(chunks[1].end).toBe("2026-01-15T00:00:00");
  });

  it("uses default maxDays of 7 when not specified", () => {
    const chunks = splitDateRange("2026-01-01T00:00:00", "2026-01-15T00:00:00");
    // 14 days / 7 = 2 chunks
    expect(chunks).toHaveLength(2);
  });

  it("works with maxDays of 1", () => {
    const chunks = splitDateRange("2026-01-01T00:00:00", "2026-01-04T00:00:00", 1);
    expect(chunks).toHaveLength(3);
    expect(chunks[0].start).toBe("2026-01-01T00:00:00");
    expect(chunks[0].end).toBe("2026-01-02T00:00:00");
    expect(chunks[1].start).toBe("2026-01-02T00:00:00");
    expect(chunks[1].end).toBe("2026-01-03T00:00:00");
    expect(chunks[2].start).toBe("2026-01-03T00:00:00");
    expect(chunks[2].end).toBe("2026-01-04T00:00:00");
  });
});
