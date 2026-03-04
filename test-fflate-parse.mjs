/**
 * Test fflate streaming unzip with the real Apple Health export.
 * This simulates what the Web Worker will do:
 * 1. Read ZIP as ArrayBuffer (103MB - fits in browser memory)
 * 2. Use fflate.unzip to decompress only export.xml
 * 3. Process decompressed Uint8Array in text chunks
 */
import { readFileSync } from "fs";
import { unzip } from "fflate";

const ZIP_PATH = "/home/ubuntu/upload/export.zip";

const APPLE_HEALTH_METRICS = {
  stepCount: "HKQuantityTypeIdentifierStepCount",
  heartRate: "HKQuantityTypeIdentifierHeartRate",
  restingHeartRate: "HKQuantityTypeIdentifierRestingHeartRate",
  hrv: "HKQuantityTypeIdentifierHeartRateVariabilitySDNN",
  activeEnergy: "HKQuantityTypeIdentifierActiveEnergyBurned",
  exerciseTime: "HKQuantityTypeIdentifierAppleExerciseTime",
  distance: "HKQuantityTypeIdentifierDistanceWalkingRunning",
  oxygenSaturation: "HKQuantityTypeIdentifierOxygenSaturation",
};
const HK_TYPE_TO_METRIC = {};
for (const [key, hkType] of Object.entries(APPLE_HEALTH_METRICS)) {
  HK_TYPE_TO_METRIC[hkType] = key;
}

const BUCKET_MS = 15 * 60 * 1000;

function parseAppleHealthDate(dateStr) {
  if (!dateStr) return NaN;
  const match = dateStr.match(/^(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2}):(\d{2})\s+([+-]\d{4})$/);
  if (!match) return new Date(dateStr).getTime();
  const [, year, month, day, hour, min, sec, tz] = match;
  return new Date(year+"-"+month+"-"+day+"T"+hour+":"+min+":"+sec+tz.slice(0,3)+":"+tz.slice(3)).getTime();
}

function extractAttr(tag, name) {
  const m = tag.match(new RegExp(name+'="([^"]*)"', "i"));
  return m ? m[1] : "";
}

async function main() {
  console.log("Reading ZIP file...");
  const startTime = Date.now();
  const zipBuffer = readFileSync(ZIP_PATH);
  console.log(`ZIP loaded: ${(zipBuffer.length / 1024 / 1024).toFixed(0)} MB in ${((Date.now()-startTime)/1000).toFixed(1)}s`);

  // Unzip - fflate will decompress all entries
  // We use the filter option to only decompress export.xml
  console.log("Decompressing export.xml with fflate...");
  const decompStart = Date.now();
  
  const result = await new Promise((resolve, reject) => {
    unzip(new Uint8Array(zipBuffer), { 
      filter: (file) => file.name.endsWith("export.xml")
    }, (err, data) => {
      if (err) reject(err);
      else resolve(data);
    });
  });

  // Find the export.xml entry
  const xmlKey = Object.keys(result).find(k => k.endsWith("export.xml"));
  if (!xmlKey) throw new Error("No export.xml found");
  
  const xmlBytes = result[xmlKey];
  console.log(`Decompressed: ${(xmlBytes.length / 1024 / 1024).toFixed(0)} MB in ${((Date.now()-decompStart)/1000).toFixed(1)}s`);
  console.log(`Heap: ${(process.memoryUsage().heapUsed / 1024 / 1024).toFixed(0)} MB`);

  // Now process the Uint8Array in chunks (decode to text chunk by chunk)
  const decoder = new TextDecoder("utf-8");
  const CHUNK_SIZE = 10 * 1024 * 1024; // 10MB text chunks
  const bucketMap = new Map();
  const workouts = [];
  let minDate = Infinity, maxDate = -Infinity;
  let totalRecords = 0, relevantDataPoints = 0;
  const metricsSet = new Set();
  let leftover = "";
  let lastPct = 0;

  const recordRegex = /<Record\s[^>]*?(?:\/?>)/gi;
  const workoutRegex = /<Workout\s[^>]*?(?:\/?>)/gi;

  console.log("Parsing XML in chunks...");
  const parseStart = Date.now();

  for (let offset = 0; offset < xmlBytes.length; offset += CHUNK_SIZE) {
    const end = Math.min(offset + CHUNK_SIZE, xmlBytes.length);
    const chunkText = decoder.decode(xmlBytes.subarray(offset, end), { stream: end < xmlBytes.length });
    const text = leftover + chunkText;

    const lastTagEnd = text.lastIndexOf(">");
    let processText;
    if (lastTagEnd === -1) { leftover = text; continue; }
    processText = text.substring(0, lastTagEnd + 1);
    leftover = text.substring(lastTagEnd + 1);

    // Records
    recordRegex.lastIndex = 0;
    let match;
    while ((match = recordRegex.exec(processText)) !== null) {
      totalRecords++;
      const tag = match[0];
      const type = extractAttr(tag, "type");
      const metricKey = HK_TYPE_TO_METRIC[type];
      if (!metricKey) continue;
      const st = parseAppleHealthDate(extractAttr(tag, "startDate"));
      const value = parseFloat(extractAttr(tag, "value"));
      if (isNaN(st) || isNaN(value)) continue;
      if (st < minDate) minDate = st;
      const et = parseAppleHealthDate(extractAttr(tag, "endDate"));
      const effectiveEnd = isNaN(et) ? st : et;
      if (effectiveEnd > maxDate) maxDate = effectiveEnd;
      metricsSet.add(metricKey);
      relevantDataPoints++;
      const bk = Math.floor(st / BUCKET_MS) * BUCKET_MS;
      if (!bucketMap.has(bk)) bucketMap.set(bk, new Map());
      const m = bucketMap.get(bk);
      if (!m.has(metricKey)) m.set(metricKey, { count: 0, sum: 0, min: Infinity, max: -Infinity });
      const s = m.get(metricKey);
      s.count++; s.sum += value;
      if (value < s.min) s.min = value;
      if (value > s.max) s.max = value;
    }

    // Workouts
    workoutRegex.lastIndex = 0;
    while ((match = workoutRegex.exec(processText)) !== null) {
      const tag = match[0];
      const at = extractAttr(tag, "workoutActivityType");
      const st = parseAppleHealthDate(extractAttr(tag, "startDate"));
      const et = parseAppleHealthDate(extractAttr(tag, "endDate"));
      if (isNaN(st)) continue;
      workouts.push({ activityType: at, startDate: new Date(st).toISOString(), endDate: isNaN(et) ? "" : new Date(et).toISOString() });
    }

    const pct = Math.round((offset / xmlBytes.length) * 100);
    if (pct > lastPct + 10) {
      lastPct = pct;
      console.log(`  ${pct}% | ${totalRecords.toLocaleString()} records | ${relevantDataPoints.toLocaleString()} relevant | heap: ${(process.memoryUsage().heapUsed/1024/1024).toFixed(0)} MB`);
    }
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log("\n=== RESULTS ===");
  console.log("Total records:", totalRecords.toLocaleString());
  console.log("Relevant:", relevantDataPoints.toLocaleString());
  console.log("Workouts:", workouts.length);
  console.log("Metrics:", Array.from(metricsSet).join(", "));
  console.log("Buckets:", bucketMap.size);
  console.log("Parse time:", ((Date.now()-parseStart)/1000).toFixed(1)+"s");
  console.log("Total time:", elapsed+"s");
  console.log("Peak heap:", (process.memoryUsage().heapUsed/1024/1024).toFixed(0), "MB");
}

main().catch(console.error);
