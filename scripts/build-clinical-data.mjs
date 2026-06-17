import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";
import zlib from "node:zlib";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ddxPath = path.join(root, "chest_pain_ddx_workflow_v1_2.xlsx");
const checklistPath = path.join(root, "chest_pain_differential_checklist_from_v1_2.xlsx");
const outputPath = path.join(root, "data", "chest-pain-clinical-data.json");

const SHEETS = {
  ddxMaster: "01_DDx_Master",
  sources: "02_Sources",
  implementationRules: "03_Implementation_Rules",
  disposition: "04_Disposition",
  appKeyChecklist: "01_AppKey_Checklist",
  comprehensiveChecklist: "02_Comprehensive_Checklist",
  coverage: "03_DDx_Coverage",
  mapVerbatim: "04_Map_Verbatim",
  redFlagGates: "05_RedFlag_Gates",
  scoreItems: "06_Score_Items",
  validation: "11_Validation",
};

function readUInt32LE(buffer, offset) {
  return buffer.readUInt32LE(offset);
}

function findEndOfCentralDirectory(buffer) {
  const min = Math.max(0, buffer.length - 0xffff - 22);
  for (let i = buffer.length - 22; i >= min; i -= 1) {
    if (readUInt32LE(buffer, i) === 0x06054b50) return i;
  }
  throw new Error("ZIP end of central directory not found");
}

function normalizeZipPath(value) {
  return value.replace(/\\/g, "/").replace(/^\/+/, "");
}

function resolveTarget(baseDir, target) {
  const normalized = normalizeZipPath(target);
  if (target.startsWith("/")) return normalized;
  return path.posix.normalize(`${baseDir}/${normalized}`);
}

async function readZip(filePath) {
  const buffer = await fs.readFile(filePath);
  const eocd = findEndOfCentralDirectory(buffer);
  const totalEntries = buffer.readUInt16LE(eocd + 10);
  const centralOffset = readUInt32LE(buffer, eocd + 16);
  const entries = new Map();
  let offset = centralOffset;

  for (let i = 0; i < totalEntries; i += 1) {
    if (readUInt32LE(buffer, offset) !== 0x02014b50) {
      throw new Error(`Invalid central directory header at ${offset}`);
    }
    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = readUInt32LE(buffer, offset + 20);
    const uncompressedSize = readUInt32LE(buffer, offset + 24);
    const fileNameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localOffset = readUInt32LE(buffer, offset + 42);
    const fileName = buffer.toString("utf8", offset + 46, offset + 46 + fileNameLength);
    entries.set(normalizeZipPath(fileName), {
      method,
      compressedSize,
      uncompressedSize,
      localOffset,
    });
    offset += 46 + fileNameLength + extraLength + commentLength;
  }

  function extract(name) {
    const entry = entries.get(normalizeZipPath(name));
    if (!entry) throw new Error(`Missing ZIP entry: ${name}`);
    const local = entry.localOffset;
    if (readUInt32LE(buffer, local) !== 0x04034b50) {
      throw new Error(`Invalid local file header for ${name}`);
    }
    const fileNameLength = buffer.readUInt16LE(local + 26);
    const extraLength = buffer.readUInt16LE(local + 28);
    const dataStart = local + 30 + fileNameLength + extraLength;
    const compressed = buffer.subarray(dataStart, dataStart + entry.compressedSize);
    if (entry.method === 0) return compressed;
    if (entry.method === 8) return zlib.inflateRawSync(compressed, { finishFlush: zlib.constants.Z_SYNC_FLUSH });
    throw new Error(`Unsupported ZIP compression method ${entry.method} in ${name}`);
  }

  function text(name) {
    return extract(name).toString("utf8").replace(/^\uFEFF/, "");
  }

  return { entries, extract, text, buffer };
}

function xmlDecode(value = "") {
  return value
    .replace(/_x000D_/g, "\n")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function attr(tag, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = tag.match(new RegExp(`\\b${escaped}="([^"]*)"`, "i"));
  return match ? xmlDecode(match[1]) : "";
}

function collectRichText(xml) {
  const parts = [];
  const re = /<(?:\w+:)?t\b[^>]*>([\s\S]*?)<\/(?:\w+:)?t>/g;
  let match;
  while ((match = re.exec(xml))) parts.push(xmlDecode(match[1]));
  return parts.join("");
}

function parseSharedStrings(xml = "") {
  const values = [];
  const re = /<[\w:]*si\b[^>]*>([\s\S]*?)<\/[\w:]*si>/g;
  let match;
  while ((match = re.exec(xml))) values.push(collectRichText(match[1]));
  return values;
}

function parseRelationships(xml) {
  const rels = new Map();
  const re = /<Relationship\b([^>]*)\/?>/g;
  let match;
  while ((match = re.exec(xml))) {
    const tag = match[1];
    rels.set(attr(tag, "Id"), {
      type: attr(tag, "Type"),
      target: attr(tag, "Target"),
    });
  }
  return rels;
}

function parseWorkbookSheets(xml, rels) {
  const sheets = [];
  const re = /<[\w:]*sheet\b([^>]*)\/?>/g;
  let match;
  while ((match = re.exec(xml))) {
    const tag = match[1];
    const id = attr(tag, "r:id");
    const rel = rels.get(id);
    if (!rel || !rel.type.includes("/worksheet")) continue;
    sheets.push({
      name: attr(tag, "name"),
      id,
      path: resolveTarget("xl", rel.target),
    });
  }
  return sheets;
}

function columnIndex(cellRef) {
  const letters = (cellRef.match(/[A-Z]+/i)?.[0] || "").toUpperCase();
  let n = 0;
  for (const ch of letters) n = n * 26 + ch.charCodeAt(0) - 64;
  return Math.max(0, n - 1);
}

function parseWorksheet(xml, sharedStrings) {
  const rows = [];
  const rowRe = /<[\w:]*row\b[^>]*>([\s\S]*?)<\/[\w:]*row>/g;
  const cellRe = /<[\w:]*c\b([^>]*)>([\s\S]*?)<\/[\w:]*c>/g;
  let rowMatch;

  while ((rowMatch = rowRe.exec(xml))) {
    const row = [];
    let cellMatch;
    while ((cellMatch = cellRe.exec(rowMatch[1]))) {
      const tag = cellMatch[1];
      const inner = cellMatch[2];
      const type = attr(tag, "t");
      const ref = attr(tag, "r");
      const col = ref ? columnIndex(ref) : row.length;
      const rawValue = inner.match(/<[\w:]*v\b[^>]*>([\s\S]*?)<\/[\w:]*v>/)?.[1] ?? "";
      let value = "";

      if (type === "s") {
        value = sharedStrings[Number(rawValue)] ?? "";
      } else if (type === "inlineStr") {
        value = collectRichText(inner);
      } else if (rawValue !== "") {
        value = xmlDecode(rawValue);
      } else {
        value = collectRichText(inner);
      }

      row[col] = cleanText(value);
    }
    rows.push(trimTrailingEmpty(row));
  }
  return rows;
}

function trimTrailingEmpty(row) {
  const copy = row.slice();
  while (copy.length && (copy[copy.length - 1] == null || copy[copy.length - 1] === "")) copy.pop();
  return copy;
}

function cleanText(value) {
  if (value == null) return "";
  return String(value)
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

async function readWorkbook(filePath) {
  const zip = await readZip(filePath);
  const rels = parseRelationships(zip.text("xl/_rels/workbook.xml.rels"));
  const sheets = parseWorkbookSheets(zip.text("xl/workbook.xml"), rels);
  const sharedStrings = zip.entries.has("xl/sharedStrings.xml") ? parseSharedStrings(zip.text("xl/sharedStrings.xml")) : [];
  const byName = {};
  for (const sheet of sheets) {
    byName[sheet.name] = {
      ...sheet,
      rows: parseWorksheet(zip.text(sheet.path), sharedStrings),
    };
  }
  return { sheets: byName };
}

function toObjects(rows, headerIndex = 0) {
  const header = rows[headerIndex] || [];
  const headers = header.map((h) => cleanText(h));
  return rows.slice(headerIndex + 1).map((row) => {
    const obj = {};
    headers.forEach((h, i) => {
      if (h) obj[h] = cleanText(row[i] ?? "");
    });
    return obj;
  }).filter((obj) => Object.values(obj).some(Boolean));
}

function splitIds(value) {
  return unique(cleanText(value)
    .split(/[;,\n]+/)
    .map((part) => part.trim())
    .filter((part) => /^(AK|CP)-\d+$/i.test(part)));
}

function splitList(value) {
  return unique(cleanText(value)
    .split(/[;\n]+/)
    .map((part) => part.trim())
    .filter(Boolean));
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function normalizeName(value) {
  return cleanText(value)
    .replace(/\s+/g, "")
    .replace(/[()]/g, "")
    .toLowerCase();
}

function rowValue(row, ...keys) {
  for (const key of keys) {
    const value = row[key];
    if (value) return cleanText(value);
  }
  return "";
}

function isRedPriority(priority) {
  return /immediate|life threat|high/i.test(priority);
}

function isRedGateText(text) {
  return /자동 게이트|항상|immediate|life threat|must/i.test(text);
}

function relatedNos(names, nameToNo) {
  return unique(names.map((name) => nameToNo.get(normalizeName(name))).filter(Boolean));
}

function buildChecklistItem(row, source, nameToNo) {
  const label = source === "appKey"
    ? rowValue(row, "앱 체크리스트 키(원문)")
    : rowValue(row, "체크 항목(원문 기반)");
  const names = splitList(rowValue(row, "관련 진단명"));
  const sourceColumn = source === "appKey" ? "앱 체크리스트 키" : rowValue(row, "출처 열");
  const evidenceText = source === "appKey" ? rowValue(row, "출처 앱키 셀 예시") : rowValue(row, "대표 원문 근거");

  return {
    id: rowValue(row, "Checklist ID"),
    source,
    section: rowValue(row, "체크 섹션") || "기타",
    label,
    displayLabel: label,
    defaultValue: rowValue(row, "평가값") || "미확인",
    memo: rowValue(row, "메모"),
    relatedDiagnosisNames: names,
    relatedDiagnosisNos: relatedNos(names, nameToNo),
    isRedRelated: rowValue(row, "Red/Must-not-miss 연관") === "예",
    sourceExample: rowValue(row, "출처 앱키 셀 예시"),
    majorImpact: rowValue(row, "주요 영향"),
    sourceColumn,
    evidenceText,
  };
}

async function sha256(filePath) {
  const hash = crypto.createHash("sha256");
  hash.update(await fs.readFile(filePath));
  return hash.digest("hex");
}

async function build() {
  const [ddxWorkbook, checklistWorkbook] = await Promise.all([
    readWorkbook(ddxPath),
    readWorkbook(checklistPath),
  ]);

  const ddxRows = toObjects(ddxWorkbook.sheets[SHEETS.ddxMaster].rows);
  const sourceRows = toObjects(ddxWorkbook.sheets[SHEETS.sources].rows);
  const implementationRules = toObjects(ddxWorkbook.sheets[SHEETS.implementationRules].rows).map((row) => ({
    id: rowValue(row, "Rule ID"),
    rule: rowValue(row, "엔진 구현 규칙"),
    description: rowValue(row, "설명/주의"),
  }));

  const dispositionSheet = ddxWorkbook.sheets[SHEETS.disposition].rows;
  const disposition = {
    notes: dispositionSheet.slice(0, 3).map((row) => row.filter(Boolean).join(" ")).filter(Boolean),
    rows: toObjects(dispositionSheet, 3),
  };

  const coverageRows = toObjects(checklistWorkbook.sheets[SHEETS.coverage].rows);
  const redFlagRows = toObjects(checklistWorkbook.sheets[SHEETS.redFlagGates].rows);
  const appKeyRows = toObjects(checklistWorkbook.sheets[SHEETS.appKeyChecklist].rows);
  const comprehensiveRows = toObjects(checklistWorkbook.sheets[SHEETS.comprehensiveChecklist].rows);
  const scoreItems = toObjects(checklistWorkbook.sheets[SHEETS.scoreItems].rows).map((row) => ({
    id: rowValue(row, "Checklist ID"),
    label: rowValue(row, "Score/기준 항목"),
    relatedDiagnosisNames: splitList(rowValue(row, "관련 진단명")),
    sourceColumn: rowValue(row, "출처 열"),
    evidenceText: rowValue(row, "대표 원문 근거"),
    defaultValue: rowValue(row, "평가값") || "미확인",
    memo: rowValue(row, "메모"),
  }));
  const validationValues = toObjects(checklistWorkbook.sheets[SHEETS.validation].rows).map((row) => rowValue(row, "평가값"));

  const coverageByNo = new Map(coverageRows.map((row) => [rowValue(row, "No"), row]));
  const redFlagNos = new Set(redFlagRows.map((row) => rowValue(row, "No")));
  const nameToNo = new Map();
  ddxRows.forEach((row) => {
    const no = Number(rowValue(row, "No"));
    if (no) nameToNo.set(normalizeName(rowValue(row, "진단노드")), no);
  });

  const diagnoses = ddxRows.map((row) => {
    const noText = rowValue(row, "No");
    const no = Number(noText);
    const coverage = coverageByNo.get(noText) || {};
    const priority = rowValue(row, "우선도");
    const mustNotMissGate = rowValue(row, "Must-not-miss gate");
    const appKeyIds = splitIds(rowValue(coverage, "앱키 Checklist ID"));
    const comprehensiveIds = splitIds(rowValue(coverage, "전체 Checklist ID"));
    const appChecklistKeys = splitList(rowValue(row, "앱 체크리스트 키"));

    return {
      no,
      nameKr: rowValue(row, "진단노드"),
      nameEn: rowValue(row, "English"),
      category: rowValue(row, "분류"),
      priority,
      mustNotMissGate,
      isRedFlag: redFlagNos.has(noText) || isRedPriority(priority) || isRedGateText(mustNotMissGate),
      suspicionClues: rowValue(row, "확률 상승/의심 단서"),
      initialTests: rowValue(row, "첫 평가/기본 검사"),
      ruleIn: rowValue(row, "Rule-in/확진 접근"),
      ruleOut: rowValue(row, "Rule-out/배제 접근"),
      pitfalls: rowValue(row, "예외/함정"),
      mimics: rowValue(row, "감별/Mimics"),
      appChecklistKeys,
      sources: rowValue(row, "주요 출처 URL"),
      evidenceLevel: rowValue(row, "근거 수준"),
      reviewStatus: rowValue(row, "검토 상태"),
      note: rowValue(row, "비고"),
      guidelineBasis: rowValue(row, "진단 1순위 근거(가이드라인)"),
      evidenceGrade: rowValue(row, "근거등급(검증 COR/LOE)"),
      revisionMemo: rowValue(row, "v1.2 변경/검토 메모"),
      appKeyIds,
      comprehensiveIds,
    };
  }).filter((diagnosis) => diagnosis.no && diagnosis.nameKr);

  const checklistItems = [
    ...appKeyRows.map((row) => buildChecklistItem(row, "appKey", nameToNo)),
    ...comprehensiveRows.map((row) => buildChecklistItem(row, "comprehensive", nameToNo)),
  ].filter((item) => item.id && item.label);

  const byId = new Map(checklistItems.map((item) => [item.id, item]));
  diagnoses.forEach((diagnosis) => {
    [...diagnosis.appKeyIds, ...diagnosis.comprehensiveIds].forEach((id) => {
      const item = byId.get(id);
      if (!item) return;
      if (!item.relatedDiagnosisNos.includes(diagnosis.no)) item.relatedDiagnosisNos.push(diagnosis.no);
      if (!item.relatedDiagnosisNames.includes(diagnosis.nameKr)) item.relatedDiagnosisNames.push(diagnosis.nameKr);
    });
  });

  const mapVerbatim = toObjects(checklistWorkbook.sheets[SHEETS.mapVerbatim].rows).map((row) => ({
    id: rowValue(row, "Checklist ID"),
    diagnosisNo: Number(rowValue(row, "No")),
    diagnosisName: rowValue(row, "진단노드"),
    section: rowValue(row, "체크 섹션"),
    label: rowValue(row, "체크 항목(원문 기반)"),
    majorImpact: rowValue(row, "주요 영향"),
    sourceColumn: rowValue(row, "출처 열"),
    verbatim: rowValue(row, "원문 셀 전체(변경 금지)"),
    sources: rowValue(row, "주요 출처 URL"),
    evidenceLevel: rowValue(row, "근거 수준"),
    evidenceGrade: rowValue(row, "근거등급(검증 COR/LOE)"),
  }));

  const data = {
    meta: {
      generatedAt: new Date().toISOString(),
      sourceFiles: [
        { name: path.basename(ddxPath), sha256: await sha256(ddxPath) },
        { name: path.basename(checklistPath), sha256: await sha256(checklistPath) },
      ],
      counts: {
        diagnoses: diagnoses.length,
        checklistItems: checklistItems.length,
        appKeyItems: appKeyRows.length,
        comprehensiveItems: comprehensiveRows.length,
        redFlagGates: redFlagRows.length,
      },
    },
    validationValues,
    diagnoses,
    checklistItems,
    redFlagGates: redFlagRows,
    implementationRules,
    disposition,
    sources: sourceRows,
    scoreItems,
    mapVerbatim,
  };

  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  console.log(`Generated ${path.relative(root, outputPath)}`);
  console.log(JSON.stringify(data.meta.counts));
}

build().catch((error) => {
  console.error(error);
  process.exit(1);
});
