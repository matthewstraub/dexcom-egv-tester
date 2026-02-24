import type { TimezoneMode } from "../../../shared/const";
import { formatDateTime } from "./timezone";

interface EgvRecord {
  recordId: string;
  systemTime: string;
  displayTime: string;
  value: number | null;
  status: string | null;
  trend: string | null;
  trendRate: number | null;
  unit: string;
  rateUnit: string;
  displayDevice: string;
  transmitterGeneration: string;
  transmitterId?: string;
  displayApp?: string;
  transmitterTicks?: number;
}

/**
 * Trigger a file download in the browser.
 */
function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/**
 * Generate a filename-safe timestamp string.
 */
function fileTimestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
}

/**
 * Export EGV records as a CSV file.
 */
export function exportCsv(
  records: EgvRecord[],
  timezone: TimezoneMode,
  env: string,
  startDate: string,
  endDate: string
) {
  const headers = [
    "systemTime",
    "displayTime",
    "displayTime_formatted",
    "value",
    "unit",
    "trend",
    "trendRate",
    "rateUnit",
    "status",
    "displayDevice",
    "displayApp",
    "transmitterGeneration",
    "transmitterId",
    "recordId",
  ];

  const rows = records.map((r) => {
    const formatted = formatDateTime(r.systemTime, timezone);
    return [
      r.systemTime,
      r.displayTime,
      formatted,
      r.value ?? "",
      r.unit,
      r.trend ?? "",
      r.trendRate ?? "",
      r.rateUnit,
      r.status ?? "",
      r.displayDevice,
      r.displayApp ?? "",
      r.transmitterGeneration,
      r.transmitterId ?? "",
      r.recordId,
    ]
      .map((v) => {
        const str = String(v);
        // Escape fields that contain commas, quotes, or newlines
        if (str.includes(",") || str.includes('"') || str.includes("\n")) {
          return `"${str.replace(/"/g, '""')}"`;
        }
        return str;
      })
      .join(",");
  });

  const csv = [headers.join(","), ...rows].join("\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  downloadBlob(blob, `dexcom-egvs_${env}_${fileTimestamp()}.csv`);
}

/**
 * Export the raw API response as a JSON file.
 */
export function exportJson(data: unknown, env: string) {
  const json = JSON.stringify(data, null, 2);
  const blob = new Blob([json], { type: "application/json;charset=utf-8;" });
  downloadBlob(blob, `dexcom-egvs_${env}_${fileTimestamp()}.json`);
}

/**
 * Export the chart as a PNG image using the SVG inside the chart container.
 * Uses html2canvas-style approach via SVG serialization + Canvas rendering.
 */
export async function exportChartPng(
  chartContainerRef: HTMLDivElement | null,
  env: string
): Promise<boolean> {
  if (!chartContainerRef) return false;

  const svgElement = chartContainerRef.querySelector("svg");
  if (!svgElement) return false;

  try {
    // Clone the SVG to avoid modifying the original
    const clonedSvg = svgElement.cloneNode(true) as SVGSVGElement;

    // Get the actual rendered dimensions
    const bbox = svgElement.getBoundingClientRect();
    const width = bbox.width;
    const height = bbox.height;

    // Set explicit dimensions on the cloned SVG
    clonedSvg.setAttribute("width", String(width));
    clonedSvg.setAttribute("height", String(height));

    // Add a dark background to the SVG
    const bgRect = document.createElementNS("http://www.w3.org/2000/svg", "rect");
    bgRect.setAttribute("width", "100%");
    bgRect.setAttribute("height", "100%");
    bgRect.setAttribute("fill", "#1a1b26");
    clonedSvg.insertBefore(bgRect, clonedSvg.firstChild);

    // Inline computed styles for text elements
    const textElements = clonedSvg.querySelectorAll("text, tspan");
    textElements.forEach((el) => {
      const htmlEl = el as SVGElement;
      // Find the corresponding original element to get computed styles
      const origEl = svgElement.querySelector(
        `${el.tagName}${el.getAttribute("x") ? `[x="${el.getAttribute("x")}"]` : ""}`
      );
      if (origEl) {
        const computed = window.getComputedStyle(origEl);
        htmlEl.style.fill = computed.fill || "oklch(0.45 0.02 264)";
        htmlEl.style.fontSize = computed.fontSize || "11px";
        htmlEl.style.fontFamily = computed.fontFamily || "'Fira Code', monospace";
      }
    });

    // Serialize the SVG
    const serializer = new XMLSerializer();
    const svgString = serializer.serializeToString(clonedSvg);
    const svgBlob = new Blob([svgString], { type: "image/svg+xml;charset=utf-8" });
    const svgUrl = URL.createObjectURL(svgBlob);

    // Render to canvas at 2x resolution for crisp output
    const scale = 2;
    const canvas = document.createElement("canvas");
    canvas.width = width * scale;
    canvas.height = height * scale;
    const ctx = canvas.getContext("2d");
    if (!ctx) return false;

    ctx.scale(scale, scale);

    return new Promise<boolean>((resolve) => {
      const img = new Image();
      img.onload = () => {
        ctx.drawImage(img, 0, 0, width, height);
        URL.revokeObjectURL(svgUrl);

        canvas.toBlob((blob) => {
          if (blob) {
            downloadBlob(blob, `dexcom-chart_${env}_${fileTimestamp()}.png`);
            resolve(true);
          } else {
            resolve(false);
          }
        }, "image/png");
      };
      img.onerror = () => {
        URL.revokeObjectURL(svgUrl);
        resolve(false);
      };
      img.src = svgUrl;
    });
  } catch (err) {
    console.error("Chart export failed:", err);
    return false;
  }
}
