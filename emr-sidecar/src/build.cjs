// EMR 사이드카 빌드 스크립트 (저장소 내 상대경로 버전)
//
// 원본 흉통_EMR_보조도구.html에서 임상 데이터셋(clinical-data)과
// SidecarCore 스크립트 청크를 추출하고, UI 셸(part_top.html)과
// 앱 로직(part_app.html)에 결합한 뒤, 검증된 KCD-8 코드맵(kcd_slim.json)과
// 국내 가이드라인 정렬 패치(dx_patch.json, 위험 감별 18개)를 주입해
// 최종 단일 파일 흉통_EMR_보조도구_간소화.html을 생성한다.
//
//   실행:  node src/build.js   (emr-sidecar 폴더 기준)

const fs = require("fs");
const path = require("path");

const SRC = __dirname;                    // emr-sidecar/src
const ROOT = path.join(__dirname, "..");  // emr-sidecar
const ORIGINAL = path.join(SRC, "흉통_EMR_보조도구.html");
const OUTPUT = path.join(ROOT, "흉통_EMR_보조도구_간소화.html");

const src = fs.readFileSync(ORIGINAL, "utf8");

const dataStart = src.indexOf('<script id="clinical-data"');
if (dataStart === -1) throw new Error("clinical-data script not found");

const coreAnchor = src.indexOf("global.SidecarCore = core;");
if (coreAnchor === -1 || coreAnchor < dataStart) throw new Error("SidecarCore anchor not found");

const coreEndTag = src.indexOf("</script>", coreAnchor);
if (coreEndTag === -1) throw new Error("SidecarCore closing tag not found");

let chunk = src.slice(dataStart, coreEndTag + "</script>".length);

if (!chunk.includes('"diagnoses":90')) throw new Error("dataset counts missing in chunk");
if (!chunk.includes("attachSidecarCore")) throw new Error("core script missing in chunk");

// 임상 데이터 JSON을 파싱해 국내 가이드라인 정렬 패치를 적용 (위험 감별 18개 필드 교체)
const dataTagOpenEnd = chunk.indexOf(">") + 1;
const dataTagClose = chunk.indexOf("</script>", dataTagOpenEnd);
const dataJson = chunk.slice(dataTagOpenEnd, dataTagClose);
const data = JSON.parse(dataJson);

const patch = JSON.parse(fs.readFileSync(path.join(SRC, "dx_patch.json"), "utf8"));
const PATCH_FIELDS = ["suspicionClues", "initialTests", "ruleIn", "ruleOut", "pitfalls", "mustNotMissGate"];
let patched = 0;
for (const diagnosis of data.diagnoses) {
  const p = patch[String(diagnosis.no)];
  if (!p) continue;
  for (const field of PATCH_FIELDS) {
    if (typeof p[field] === "string" && p[field].trim()) diagnosis[field] = p[field];
  }
  patched++;
}
chunk = chunk.slice(0, dataTagOpenEnd) + JSON.stringify(data) + chunk.slice(dataTagClose);
console.log("patch applied to", patched, "diagnoses");

const top = fs.readFileSync(path.join(SRC, "part_top.html"), "utf8");
let app = fs.readFileSync(path.join(SRC, "part_app.html"), "utf8");

// 검증된 KCD-8 코드맵 주입 (90개 질환)
const kcd = fs.readFileSync(path.join(SRC, "kcd_slim.json"), "utf8").trim();
if (!app.includes("const KCD_CODES = {};")) throw new Error("KCD_CODES placeholder not found in app");
if (Object.keys(JSON.parse(kcd)).length !== 90) throw new Error("KCD map does not have 90 entries");
app = app.replace("const KCD_CODES = {};", `const KCD_CODES = ${kcd};`);

const out = `${top.trimEnd()}\n\n  ${chunk}\n${app.trimEnd()}\n`;
fs.writeFileSync(OUTPUT, out, "utf8");

console.log("written:", OUTPUT);
console.log("size:", (fs.statSync(OUTPUT).size / 1024 / 1024).toFixed(2), "MB");
