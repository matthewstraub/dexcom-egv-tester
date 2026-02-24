import { describe, expect, it, vi, beforeEach } from "vitest";

// We need to set up DOM mocks before importing the module
// since the test environment is "node"

let capturedBlobContent: string[] = [];
let capturedBlobType: string = "";
const mockClick = vi.fn();
const mockAppendChild = vi.fn();
const mockRemoveChild = vi.fn();

// Mock DOM APIs
const mockCreateObjectURL = vi.fn(() => "blob:mock-url");
const mockRevokeObjectURL = vi.fn();

// Set up globals before import
vi.stubGlobal("URL", {
  createObjectURL: mockCreateObjectURL,
  revokeObjectURL: mockRevokeObjectURL,
});

const OriginalBlob = globalThis.Blob;
vi.stubGlobal(
  "Blob",
  class MockBlob extends OriginalBlob {
    constructor(parts?: BlobPart[], options?: BlobPropertyBag) {
      super(parts, options);
      capturedBlobContent = (parts || []).map((p) => String(p));
      capturedBlobType = options?.type || "";
    }
  }
);

vi.stubGlobal("document", {
  createElement: vi.fn(() => ({
    href: "",
    download: "",
    click: mockClick,
    style: {},
  })),
  body: {
    appendChild: mockAppendChild,
    removeChild: mockRemoveChild,
  },
});

// Now import the module after mocks are in place
const { exportCsv, exportJson } = await import("./export");

const sampleRecords = [
  {
    recordId: "abc-123",
    systemTime: "2024-01-15T12:00:00Z",
    displayTime: "2024-01-15T07:00:00-05:00",
    value: 120,
    status: null,
    trend: "flat",
    trendRate: 0.5,
    unit: "mg/dL",
    rateUnit: "mg/dL/min",
    displayDevice: "iOS",
    transmitterGeneration: "g7",
    displayApp: "G7",
    transmitterId: "tx-001",
  },
  {
    recordId: "def-456",
    systemTime: "2024-01-15T12:05:00Z",
    displayTime: "2024-01-15T07:05:00-05:00",
    value: 135,
    status: null,
    trend: "fortyFiveUp",
    trendRate: 1.2,
    unit: "mg/dL",
    rateUnit: "mg/dL/min",
    displayDevice: "iOS",
    transmitterGeneration: "g7",
    displayApp: "G7",
    transmitterId: "tx-001",
  },
];

describe("export utilities", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    capturedBlobContent = [];
    capturedBlobType = "";
  });

  describe("exportCsv", () => {
    it("generates CSV with correct headers", () => {
      exportCsv(sampleRecords, "utc", "sandbox", "2024-01-15T00:00:00", "2024-01-15T23:59:59");

      expect(capturedBlobContent.length).toBe(1);
      const csv = capturedBlobContent[0];
      const lines = csv.split("\n");

      expect(lines[0]).toBe(
        "systemTime,displayTime,displayTime_formatted,value,unit,trend,trendRate,rateUnit,status,displayDevice,displayApp,transmitterGeneration,transmitterId,recordId"
      );
    });

    it("generates correct number of data rows", () => {
      exportCsv(sampleRecords, "utc", "sandbox", "2024-01-15T00:00:00", "2024-01-15T23:59:59");

      const csv = capturedBlobContent[0];
      const lines = csv.split("\n");
      // 1 header + 2 data rows
      expect(lines.length).toBe(3);
    });

    it("includes correct values in data rows", () => {
      exportCsv(sampleRecords, "utc", "sandbox", "2024-01-15T00:00:00", "2024-01-15T23:59:59");

      const csv = capturedBlobContent[0];
      const lines = csv.split("\n");
      const firstRow = lines[1];

      expect(firstRow).toContain("2024-01-15T12:00:00Z");
      expect(firstRow).toContain("120");
      expect(firstRow).toContain("mg/dL");
      expect(firstRow).toContain("flat");
      expect(firstRow).toContain("abc-123");
    });

    it("creates blob with CSV mime type", () => {
      exportCsv(sampleRecords, "utc", "sandbox", "2024-01-15T00:00:00", "2024-01-15T23:59:59");
      expect(capturedBlobType).toBe("text/csv;charset=utf-8;");
    });

    it("triggers download", () => {
      exportCsv(sampleRecords, "utc", "sandbox", "2024-01-15T00:00:00", "2024-01-15T23:59:59");
      expect(mockClick).toHaveBeenCalledOnce();
      expect(mockAppendChild).toHaveBeenCalledOnce();
      expect(mockRemoveChild).toHaveBeenCalledOnce();
    });

    it("handles null values gracefully", () => {
      const recordsWithNulls = [
        {
          ...sampleRecords[0],
          value: null,
          status: null,
          trend: null,
          trendRate: null,
        },
      ];

      exportCsv(recordsWithNulls, "utc", "sandbox", "2024-01-15T00:00:00", "2024-01-15T23:59:59");

      const csv = capturedBlobContent[0];
      const lines = csv.split("\n");
      expect(lines.length).toBe(2);
    });
  });

  describe("exportJson", () => {
    it("creates blob with JSON content", () => {
      const data = { records: sampleRecords, userId: "test-user" };
      exportJson(data, "sandbox");

      const json = capturedBlobContent[0];
      const parsed = JSON.parse(json);
      expect(parsed.records).toHaveLength(2);
      expect(parsed.userId).toBe("test-user");
    });

    it("creates blob with JSON mime type", () => {
      exportJson({ records: [] }, "sandbox");
      expect(capturedBlobType).toBe("application/json;charset=utf-8;");
    });

    it("triggers download", () => {
      exportJson({ records: [] }, "production");
      expect(mockClick).toHaveBeenCalledOnce();
    });

    it("formats JSON with indentation", () => {
      exportJson({ key: "value" }, "sandbox");
      const json = capturedBlobContent[0];
      expect(json).toContain("\n");
      expect(json).toContain("  ");
    });
  });
});
