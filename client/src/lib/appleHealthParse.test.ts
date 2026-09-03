import { describe, expect, it } from "vitest";
import {
  BUCKET_MS,
  createHealthAggregator,
  extractAttr,
  findExportXmlFromCentralDir,
  parseAppleHealthDate,
  parseHealthExport,
  type ParseProgress,
} from "./appleHealthParse";

// ── ZIP fixture builder ───────────────────────────────────────────────
// Apple Health exports set the data-descriptor flag (0x0008), which zeroes the
// size fields in the local header — the whole reason the parser reads the
// central directory. The fixtures below reproduce that shape.

async function deflateRaw(bytes: Uint8Array): Promise<Uint8Array> {
  const cs = new CompressionStream("deflate-raw");
  const writer = cs.writable.getWriter();
  void writer.write(bytes);
  void writer.close();
  return new Uint8Array(await new Response(cs.readable).arrayBuffer());
}

type ZipInput = { name: string; content: string; store?: boolean };

async function makeZip(entries: ZipInput[]): Promise<Uint8Array> {
  const enc = new TextEncoder();
  const prepared = [];
  for (const e of entries) {
    const raw = enc.encode(e.content);
    const data = e.store ? raw : await deflateRaw(raw);
    prepared.push({
      name: enc.encode(e.name),
      method: e.store ? 0 : 8,
      data,
      uncompressedSize: raw.length,
    });
  }

  const chunks: Uint8Array[] = [];
  const offsets: number[] = [];
  let pos = 0;

  for (const p of prepared) {
    offsets.push(pos);
    const lh = new Uint8Array(30 + p.name.length);
    const v = new DataView(lh.buffer);
    v.setUint32(0, 0x04034b50, true);
    v.setUint16(4, 20, true);
    v.setUint16(6, 0x0008, true); // data descriptor flag, as Apple Health does
    v.setUint16(8, p.method, true);
    v.setUint32(14, 0, true); // crc32 lives in the descriptor
    v.setUint32(18, 0, true); // compressed size: zero here on purpose
    v.setUint32(22, 0, true); // uncompressed size: zero here on purpose
    v.setUint16(26, p.name.length, true);
    v.setUint16(28, 0, true);
    lh.set(p.name, 30);
    chunks.push(lh, p.data);
    pos += lh.length + p.data.length;
  }

  const cdStart = pos;
  prepared.forEach((p, i) => {
    const cd = new Uint8Array(46 + p.name.length);
    const v = new DataView(cd.buffer);
    v.setUint32(0, 0x02014b50, true);
    v.setUint16(4, 20, true);
    v.setUint16(6, 20, true);
    v.setUint16(8, 0x0008, true);
    v.setUint16(10, p.method, true);
    v.setUint32(16, 0, true);
    v.setUint32(20, p.data.length, true); // real sizes only in the central dir
    v.setUint32(24, p.uncompressedSize, true);
    v.setUint16(28, p.name.length, true);
    v.setUint16(30, 0, true);
    v.setUint16(32, 0, true);
    v.setUint32(42, offsets[i]!, true);
    cd.set(p.name, 46);
    chunks.push(cd);
    pos += cd.length;
  });

  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, prepared.length, true);
  ev.setUint16(10, prepared.length, true);
  ev.setUint32(12, pos - cdStart, true);
  ev.setUint32(16, cdStart, true);
  chunks.push(eocd);

  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  return out;
}

const HR = "HKQuantityTypeIdentifierHeartRate";
const STEPS = "HKQuantityTypeIdentifierStepCount";

function record(type: string, value: string, start: string, end = start) {
  return `<Record type="${type}" sourceName="Watch" unit="count/min" startDate="${start}" endDate="${end}" value="${value}"/>`;
}

const SAMPLE_XML = `<?xml version="1.0" encoding="UTF-8"?>
<HealthData locale="en_US">
 ${record(HR, "60", "2024-01-15 08:00:00 -0500")}
 ${record(HR, "80", "2024-01-15 08:10:00 -0500")}
 ${record(STEPS, "100", "2024-01-15 08:05:00 -0500")}
 ${record(HR, "70", "2024-01-15 08:20:00 -0500")}
 ${record("HKQuantityTypeIdentifierBodyMass", "180", "2024-01-15 08:00:00 -0500")}
 <Workout workoutActivityType="HKWorkoutActivityTypeRunning" duration="30.5" sourceName="Watch" startDate="2024-01-15 09:00:00 -0500" endDate="2024-01-15 09:30:00 -0500"/>
 <Workout workoutActivityType="HKWorkoutActivityTypeBadminton" duration="15" startDate="2024-01-15 07:00:00 -0500" endDate="2024-01-15 07:15:00 -0500"/>
</HealthData>`;

// ── parseAppleHealthDate ──────────────────────────────────────────────

describe("parseAppleHealthDate", () => {
  it("parses Apple's space-separated format with a UTC offset", () => {
    // 08:30 at -0500 is 13:30 UTC
    expect(parseAppleHealthDate("2024-01-15 08:30:00 -0500")).toBe(
      Date.parse("2024-01-15T13:30:00Z")
    );
  });

  it("honours a positive offset", () => {
    expect(parseAppleHealthDate("2024-01-15 08:30:00 +0200")).toBe(
      Date.parse("2024-01-15T06:30:00Z")
    );
  });

  it("falls back to Date parsing for ISO strings", () => {
    expect(parseAppleHealthDate("2024-01-15T08:30:00Z")).toBe(Date.parse("2024-01-15T08:30:00Z"));
  });

  it("returns NaN for empty or unparseable input", () => {
    expect(parseAppleHealthDate("")).toBeNaN();
    expect(parseAppleHealthDate("not a date")).toBeNaN();
  });
});

// ── extractAttr ───────────────────────────────────────────────────────

describe("extractAttr", () => {
  const tag = '<Record type="A" value="42" sourceName=""/>';

  it("reads an attribute value", () => {
    expect(extractAttr(tag, "type")).toBe("A");
    expect(extractAttr(tag, "value")).toBe("42");
  });

  it("returns an empty string for a missing attribute", () => {
    expect(extractAttr(tag, "unit")).toBe("");
  });

  it("returns an empty string for an empty attribute", () => {
    expect(extractAttr(tag, "sourceName")).toBe("");
  });
});

// ── findExportXmlFromCentralDir ───────────────────────────────────────

describe("findExportXmlFromCentralDir", () => {
  it("finds export.xml and reports sizes from the central directory", async () => {
    const zip = await makeZip([{ name: "apple_health_export/export.xml", content: SAMPLE_XML }]);
    const entry = findExportXmlFromCentralDir(zip)!;

    expect(entry).not.toBeNull();
    expect(entry.fileName).toBe("apple_health_export/export.xml");
    expect(entry.compressionMethod).toBe(8);
    expect(entry.uncompressedSize).toBe(new TextEncoder().encode(SAMPLE_XML).length);
    expect(entry.compressedSize).toBeGreaterThan(0);
    // the local header claims zero, so a parser trusting it would read nothing
    expect(entry.dataOffset).toBeGreaterThan(30);
  });

  it("skips other entries to find export.xml", async () => {
    const zip = await makeZip([
      { name: "apple_health_export/export_cda.xml", content: "<ignored/>" },
      { name: "apple_health_export/electrocardiograms/ecg.csv", content: "a,b,c" },
      { name: "apple_health_export/export.xml", content: SAMPLE_XML },
    ]);
    expect(findExportXmlFromCentralDir(zip)!.fileName).toBe("apple_health_export/export.xml");
  });

  it("returns null for a valid ZIP with no export.xml", async () => {
    const zip = await makeZip([{ name: "notes.txt", content: "hello" }]);
    expect(findExportXmlFromCentralDir(zip)).toBeNull();
  });

  it("throws when the EOCD signature is absent", () => {
    expect(() => findExportXmlFromCentralDir(new Uint8Array(200))).toThrow(/EOCD/);
  });
});

// ── createHealthAggregator ────────────────────────────────────────────

describe("createHealthAggregator", () => {
  function aggregate(xml: string) {
    const agg = createHealthAggregator();
    agg.ingest(xml);
    return agg.finish();
  }

  it("aggregates a metric into 15-minute buckets", () => {
    const { buckets } = aggregate(SAMPLE_XML);
    // 08:00 and 08:10 (-0500) land in the 13:00 UTC bucket; 08:20 in 13:15
    const first = buckets.find((b) => b.bucketStart === "2024-01-15T13:00:00.000Z")!;
    expect(first.metrics.heartRate).toEqual({
      avg: 70,
      min: 60,
      max: 80,
      sum: 140,
      count: 2,
    });
    const second = buckets.find((b) => b.bucketStart === "2024-01-15T13:15:00.000Z")!;
    expect(second.metrics.heartRate.count).toBe(1);
    expect(second.metrics.heartRate.avg).toBe(70);
  });

  it("keeps multiple metrics in the same bucket", () => {
    const { buckets, summary } = aggregate(SAMPLE_XML);
    const first = buckets.find((b) => b.bucketStart === "2024-01-15T13:00:00.000Z")!;
    expect(Object.keys(first.metrics).sort()).toEqual(["heartRate", "stepCount"]);
    expect(first.metrics.stepCount.sum).toBe(100);
    expect(summary.metricsFound.sort()).toEqual(["heartRate", "stepCount"]);
  });

  it("counts every Record but only aggregates recognised metrics", () => {
    const { summary } = aggregate(SAMPLE_XML);
    expect(summary.recordCount).toBe(5); // includes the BodyMass record
    expect(summary.relevantDataPoints).toBe(4); // which is not a tracked metric
  });

  it("sets bucketEnd one bucket width after bucketStart", () => {
    const { buckets } = aggregate(SAMPLE_XML);
    for (const b of buckets) {
      expect(Date.parse(b.bucketEnd) - Date.parse(b.bucketStart)).toBe(BUCKET_MS);
    }
  });

  it("returns buckets in chronological order", () => {
    const { buckets } = aggregate(SAMPLE_XML);
    const times = buckets.map((b) => Date.parse(b.bucketStart));
    expect(times).toEqual([...times].sort((a, b) => a - b));
  });

  it("spans dateRange from the earliest start to the latest end", () => {
    const { summary } = aggregate(SAMPLE_XML);
    expect(summary.dateRange).toEqual({
      start: "2024-01-15T13:00:00.000Z",
      end: "2024-01-15T13:20:00.000Z",
    });
  });

  it("skips records with an unparseable value or date", () => {
    const { summary } = aggregate(`<HealthData>
      ${record(HR, "not-a-number", "2024-01-15 08:00:00 -0500")}
      ${record(HR, "60", "garbage")}
      ${record(HR, "72", "2024-01-15 08:00:00 -0500")}
    </HealthData>`);
    expect(summary.recordCount).toBe(3);
    expect(summary.relevantDataPoints).toBe(1);
  });

  it("parses workouts, mapping known types and stripping unknown ones", () => {
    const { workouts, summary } = aggregate(SAMPLE_XML);
    expect(summary.workoutCount).toBe(2);
    // sorted chronologically, so Badminton (07:00) comes first
    expect(workouts[0]!.activityLabel).toBe("Badminton");
    expect(workouts[1]!.activityLabel).toBe("Running");
    expect(workouts[1]!.duration).toBe(30.5);
    expect(workouts[1]!.sourceName).toBe("Watch");
    expect(workouts[1]!.startDate).toBe("2024-01-15T14:00:00.000Z");
  });

  it("returns an empty result for XML with no records", () => {
    const { summary, buckets, workouts } = aggregate("<HealthData></HealthData>");
    expect(buckets).toEqual([]);
    expect(workouts).toEqual([]);
    expect(summary.dateRange).toBeNull();
    expect(summary.bucketCount).toBe(0);
  });

  it("produces identical results no matter where the input is split", () => {
    const whole = aggregate(SAMPLE_XML);
    // every possible split point, so a tag broken across chunks is covered
    for (let i = 0; i <= SAMPLE_XML.length; i++) {
      const agg = createHealthAggregator();
      agg.ingest(SAMPLE_XML.slice(0, i));
      agg.ingest(SAMPLE_XML.slice(i));
      expect(agg.finish(), `split at ${i}`).toEqual(whole);
    }
  });

  it("handles input arriving one character at a time", () => {
    const agg = createHealthAggregator();
    for (const ch of SAMPLE_XML) agg.ingest(ch);
    expect(agg.finish()).toEqual(aggregate(SAMPLE_XML));
  });
});

// ── parseHealthExport (full pipeline) ─────────────────────────────────

describe("parseHealthExport", () => {
  it("locates, decompresses and parses export.xml end to end", async () => {
    const zip = await makeZip([{ name: "apple_health_export/export.xml", content: SAMPLE_XML }]);
    const result = await parseHealthExport(zip);

    expect(result.summary.recordCount).toBe(5);
    expect(result.summary.relevantDataPoints).toBe(4);
    expect(result.summary.workoutCount).toBe(2);
    expect(result.summary.metricsFound.sort()).toEqual(["heartRate", "stepCount"]);
    expect(result.summary.bucketCount).toBe(result.buckets.length);
    expect(result.buckets.find((b) => b.bucketStart === "2024-01-15T13:00:00.000Z")!.metrics.heartRate.avg).toBe(70);
  });

  it("matches what the aggregator produces from the raw XML", async () => {
    const zip = await makeZip([{ name: "apple_health_export/export.xml", content: SAMPLE_XML }]);
    const agg = createHealthAggregator();
    agg.ingest(SAMPLE_XML);
    expect(await parseHealthExport(zip)).toEqual(agg.finish());
  });

  it("reports progress through to completion", async () => {
    const zip = await makeZip([{ name: "apple_health_export/export.xml", content: SAMPLE_XML }]);
    const seen: ParseProgress[] = [];
    await parseHealthExport(zip, (p) => seen.push(p));

    expect(seen.map((p) => p.stage)).toContain("extracting");
    expect(seen.map((p) => p.stage)).toContain("parsing");
    expect(seen.at(-1)!.stage).toBe("done");
    expect(seen.at(-1)!.pct).toBe(100);
  });

  it("rejects a ZIP with no export.xml", async () => {
    const zip = await makeZip([{ name: "notes.txt", content: "hello" }]);
    await expect(parseHealthExport(zip)).rejects.toThrow(/Could not find export\.xml/);
  });

  it("rejects an export.xml that is stored rather than deflated", async () => {
    const zip = await makeZip([
      { name: "apple_health_export/export.xml", content: SAMPLE_XML, store: true },
    ]);
    await expect(parseHealthExport(zip)).rejects.toThrow(/Unsupported compression method: 0/);
  });

  it("handles an export larger than a single feed chunk", async () => {
    // > 512KB compressed input forces multiple reads out of the decompressor
    const many = Array.from({ length: 20000 }, (_, i) =>
      record(HR, String(60 + (i % 40)), `2024-01-15 08:${String(i % 60).padStart(2, "0")}:00 -0500`)
    ).join("\n");
    const zip = await makeZip([
      { name: "apple_health_export/export.xml", content: `<HealthData>${many}</HealthData>` },
    ]);
    const result = await parseHealthExport(zip);
    expect(result.summary.recordCount).toBe(20000);
    expect(result.summary.relevantDataPoints).toBe(20000);
    const totalCount = result.buckets.reduce((n, b) => n + (b.metrics.heartRate?.count ?? 0), 0);
    expect(totalCount).toBe(20000);
  });
});
