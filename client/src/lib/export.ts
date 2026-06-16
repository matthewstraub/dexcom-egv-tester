import type { TimezoneMode } from "../../../shared/const";
import { formatDateTime, getLocalTimezoneAbbr } from "./timezone";

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

export interface ChartExportMeta {
  startDate: string;
  endDate: string;
  timezone: TimezoneMode;
  avgGlucose: number | null;
  recordCount: number;
  env: string;
}

/**
 * Export the chart as a PNG image using the SVG inside the chart container.
 * Adds a header with date range, start/end dates, and average glucose.
 */
export async function exportChartPng(
  chartContainerRef: HTMLDivElement | null,
  env: string,
  meta?: ChartExportMeta
): Promise<boolean> {
  if (!chartContainerRef) return false;

  const svgElement = chartContainerRef.querySelector("svg");
  if (!svgElement) return false;

  try {
    // Clone the SVG to avoid modifying the original
    const clonedSvg = svgElement.cloneNode(true) as SVGSVGElement;

    // Get the actual rendered dimensions
    const bbox = svgElement.getBoundingClientRect();
    const chartWidth = bbox.width;
    const chartHeight = bbox.height;

    // Set explicit dimensions on the cloned SVG
    clonedSvg.setAttribute("width", String(chartWidth));
    clonedSvg.setAttribute("height", String(chartHeight));

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

    // Calculate header height
    const headerHeight = meta ? 80 : 0;
    const padding = 24;
    const totalWidth = chartWidth;
    const totalHeight = chartHeight + headerHeight;

    // Render to canvas at 2x resolution for crisp output
    const scale = 2;
    const canvas = document.createElement("canvas");
    canvas.width = totalWidth * scale;
    canvas.height = totalHeight * scale;
    const ctx = canvas.getContext("2d");
    if (!ctx) return false;

    ctx.scale(scale, scale);

    return new Promise<boolean>((resolve) => {
      const img = new Image();
      img.onload = () => {
        // Draw dark background for entire canvas
        ctx.fillStyle = "#1a1b26";
        ctx.fillRect(0, 0, totalWidth, totalHeight);

        // Draw header if metadata provided
        if (meta) {
          const tzLabel = meta.timezone === "utc" ? "UTC" : getLocalTimezoneAbbr();
          const startFormatted = formatDateTime(meta.startDate, meta.timezone);
          const endFormatted = formatDateTime(meta.endDate, meta.timezone);
          const diffMs = new Date(meta.endDate + (meta.endDate.endsWith("Z") ? "" : "Z")).getTime() -
                         new Date(meta.startDate + (meta.startDate.endsWith("Z") ? "" : "Z")).getTime();
          const diffDays = diffMs / (1000 * 60 * 60 * 24);
          const rangeLabel = diffDays < 1
            ? `${(diffDays * 24).toFixed(1)} hours`
            : `${diffDays.toFixed(1)} days`;

          // Title line
          ctx.fillStyle = "#c0caf5";
          ctx.font = "bold 16px 'Fira Code', 'Courier New', monospace";
          ctx.fillText(`Glucose Timeline (${tzLabel})`, padding, 28);

          // Average glucose (right-aligned)
          if (meta.avgGlucose !== null) {
            const avgText = `Avg: ${Math.round(meta.avgGlucose)} mg/dL`;
            const avgColor = meta.avgGlucose < 80 ? "#f7768e" : meta.avgGlucose <= 180 ? "#9ece6a" : "#e0af68";
            ctx.font = "bold 15px 'Fira Code', 'Courier New', monospace";
            const avgWidth = ctx.measureText(avgText).width;
            ctx.fillStyle = avgColor;
            ctx.fillText(avgText, totalWidth - padding - avgWidth, 28);
          }

          // Date range line
          ctx.fillStyle = "#565f89";
          ctx.font = "12px 'Fira Code', 'Courier New', monospace";
          ctx.fillText(`${startFormatted}  \u2192  ${endFormatted}`, padding, 50);

          // Stats line
          const statsText = `Range: ${rangeLabel}  \u00B7  ${meta.recordCount.toLocaleString()} records  \u00B7  ${meta.env === "production" ? "Production" : "Sandbox"}`;
          ctx.fillText(statsText, padding, 68);

          // Separator line
          ctx.strokeStyle = "#2a2b3d";
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(padding, headerHeight - 4);
          ctx.lineTo(totalWidth - padding, headerHeight - 4);
          ctx.stroke();
        }

        // Draw chart below header
        ctx.drawImage(img, 0, headerHeight, chartWidth, chartHeight);
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
