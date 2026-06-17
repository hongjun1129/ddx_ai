const DATA_URL = "data/chest-pain-clinical-data.json";
const VALUES = ["미확인", "있음", "없음", "해당없음"];
const YES = "있음";
const NO = "없음";
const UNKNOWN = "미확인";
const NA = "해당없음";

const SECTION_ORDER = [
  "활력/즉시위험",
  "문진/증상",
  "위험인자/과거력",
  "ECG/혈액/검사",
  "기본평가/검사",
  "신체진찰",
  "영상/시술/확진",
  "진단확인/배제/함정",
  "위장관/식도",
  "근골격/신경/흉벽",
  "정신/기능",
  "Score/기준",
  "기타",
];

const EXAMPLE_NOTE = [
  "67세 남자. 2시간 전부터 흉골하 압박감.",
  "좌측 팔로 방사, 식은땀 동반. 호흡곤란 약간 있음. 발열 없음.",
  "BP 150/90, HR 96, SpO2 97%.",
  "ECG ST elevation 없음. Troponin pending.",
  "과거력: HTN, DM, current smoker.",
].join("\n");
const EXAMPLE_PT = { name: "홍길동", age: "67", sex: "남성" };
const EXAMPLE_VITALS = { sbp: "150", dbp: "90", hr: "96", rr: "22", spo2: "97", bt: "37.2" };

const PMH_RULES = [
  { re: /고혈압|\bHTN\b|hypertension/i, label: "고혈압 (HTN)" },
  { re: /당뇨|\bDM\b|diabetes/i, label: "당뇨 (DM)" },
  { re: /흡연|smok|담배/i, label: "현재 흡연" },
  { re: /고지혈|이상지질|dyslipidem|hyperlipidem/i, label: "이상지질혈증" },
  { re: /비만|obes/i, label: "비만" },
  { re: /가족력|family\s*history/i, label: "CAD 가족력" },
  { re: /만성\s*콩팥|만성\s*신장?|\bCKD\b|신부전/i, label: "만성콩팥병 (CKD)" },
  { re: /심근경색|관상동맥|\bCAD\b|스텐트|stent|\bMI\b/i, label: "관상동맥질환 과거력" },
  { re: /뇌졸중|뇌경색|stroke/i, label: "뇌졸중 과거력" },
];

const appState = {
  clinicalData: null,
  checklistById: new Map(),
  diagnosisByNo: new Map(),
  checklistState: {},
  lastExtraction: null,
  rankedDiagnoses: [],
  pendingReviewItems: [],
};

function $(id) {
  return document.getElementById(id);
}

function nowStamp() {
  const d = new Date();
  const p = (n) => (n < 10 ? "0" : "") + n;
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function setStatus(message, type = "") {
  const node = $("analysis-status");
  node.textContent = message || "";
  node.className = `status-line${type ? ` ${type}` : ""}`;
}

async function init() {
  $("rec-time").textContent = `내원 ${nowStamp()}`;
  calcV();
  showResults(false);
  renderEmptyChecklistModal();
  try {
    const res = await fetch(DATA_URL, { cache: "no-store" });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    const data = await res.json();
    appState.clinicalData = data;
    indexClinicalData(data);
    resetChecklistState();
    renderChecklistModal();
    setStatus(`임상 데이터 로드 완료: 진단 ${data.meta.counts.diagnoses}개, 체크리스트 ${data.meta.counts.checklistItems}개`, "ok");
  } catch (error) {
    setStatus(`데이터 로딩 실패: ${error.message}. npm start로 서버를 실행한 뒤 접속하세요.`, "error");
  }
}

function indexClinicalData(data) {
  appState.checklistById = new Map(data.checklistItems.map((item) => [item.id, item]));
  appState.diagnosisByNo = new Map(data.diagnoses.map((dx) => [dx.no, dx]));
}

function resetChecklistState() {
  appState.checklistState = {};
  for (const item of appState.clinicalData.checklistItems) {
    appState.checklistState[item.id] = {
      value: UNKNOWN,
      source: null,
      quote: "",
      rationale: "",
      confidence: null,
      updatedAt: "",
    };
  }
  appState.lastExtraction = null;
  appState.rankedDiagnoses = [];
}

function collectVitals() {
  return {
    sbp: $("sbp").value.trim(),
    dbp: $("dbp").value.trim(),
    hr: $("hr").value.trim(),
    rr: $("rr").value.trim(),
    spo2: $("spo2").value.trim(),
    bt: $("bt").value.trim(),
  };
}

function collectPatient() {
  return {
    age: $("age").value.trim(),
    sex: $("sex").value || "",
  };
}

async function analyze() {
  if (!appState.clinicalData) {
    setStatus("임상 데이터가 아직 로드되지 않았습니다.", "error");
    return;
  }

  const note = $("note").value.trim();
  if (!note) {
    setStatus("입력 내용을 먼저 작성하세요. 예시는 왼쪽 버튼으로 불러올 수 있습니다.", "error");
    return;
  }

  const btn = $("analyze-btn");
  btn.disabled = true;
  btn.textContent = "추출 중...";
  setStatus("체크리스트 후보를 구성하고 단서를 추출하는 중입니다.");

  try {
    const vitals = collectVitals();
    const vitalItems = buildVitalExtraction(vitals);
    const candidateChecklist = buildCandidateChecklist(note, vitalItems);
    const res = await fetch("/api/extract-clues", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        patient: collectPatient(),
        vitals,
        note,
        candidateChecklist,
      }),
    });
    if (!res.ok) throw new Error(await res.text());
    const result = await res.json();
    appState.lastExtraction = result;

    const llmItems = (result.items || []).map((item) => toReviewItem(item, "llm")).filter(Boolean);
    const reviewItems = mergeReviewItems([...llmItems, ...vitalItems]);
    if (!reviewItems.length) {
      setStatus("명확히 반영할 단서를 찾지 못했습니다. 체크리스트 전체 보기에서 수동으로 표시할 수 있습니다.", "error");
      return;
    }
    renderReviewModal(reviewItems, result);
    openModal("reviewModal");
    setStatus(result.mock ? "개발용 mock 추출 결과가 준비되었습니다. 확인 후 반영하세요." : "추출 결과가 준비되었습니다. 확인 후 반영하세요.");
  } catch (error) {
    setStatus(`단서 추출 실패: ${String(error.message || error).slice(0, 240)}`, "error");
  } finally {
    btn.disabled = false;
    btn.textContent = "임상 단서 추출";
  }
}

function toReviewItem(raw, source) {
  const item = appState.checklistById.get(raw.id);
  if (!item) return null;
  let value = VALUES.includes(raw.value) ? raw.value : UNKNOWN;
  if (typeof raw.confidence === "number" && raw.confidence < 0.6 && value === YES) value = UNKNOWN;
  return {
    ...raw,
    id: item.id,
    source,
    section: item.section,
    label: item.displayLabel || item.label,
    relatedDiagnosisNames: item.relatedDiagnosisNames || [],
    value,
    confidence: typeof raw.confidence === "number" ? raw.confidence : null,
    quote: raw.quote || "",
    rationale: raw.rationale || "",
  };
}

function mergeReviewItems(items) {
  const scoreValue = { [YES]: 3, [NO]: 2, [UNKNOWN]: 1, [NA]: 0 };
  const map = new Map();
  for (const item of items) {
    const prev = map.get(item.id);
    if (!prev || scoreValue[item.value] > scoreValue[prev.value] || (item.confidence || 0) > (prev.confidence || 0)) {
      map.set(item.id, item);
    }
  }
  return [...map.values()].sort((a, b) => sectionRank(a.section) - sectionRank(b.section) || a.id.localeCompare(b.id));
}

function renderReviewModal(items, result) {
  appState.pendingReviewItems = items;
  const summary = $("review-summary");
  const warnings = (result.warnings || []).join(" ");
  summary.textContent = `${result.summary || "추출 후보를 확인하세요."}${warnings ? ` · ${warnings}` : ""}`;

  const body = $("review-body");
  body.innerHTML = "";
  const fragment = document.createDocumentFragment();
  items.forEach((item, index) => {
    const row = document.createElement("div");
    row.className = "review-row";

    const sec = document.createElement("div");
    sec.className = "review-sec";
    sec.textContent = item.section;

    const main = document.createElement("div");
    main.className = "review-main";
    const label = document.createElement("div");
    label.className = "review-label";
    label.textContent = item.label;
    const meta = document.createElement("div");
    meta.className = `review-meta${item.confidence !== null && item.confidence < 0.75 ? " warn" : ""}`;
    const conf = item.confidence === null ? "n/a" : Math.round(item.confidence * 100) + "%";
    meta.textContent = `${item.source === "vital-rule" ? "vital-rule" : "LLM"} · confidence ${conf}${item.quote ? ` · "${item.quote}"` : ""}${item.rationale ? ` · ${item.rationale}` : ""}`;
    main.append(label, meta);

    const select = document.createElement("select");
    select.className = "review-select";
    select.dataset.reviewIndex = String(index);
    VALUES.forEach((value) => {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = value;
      option.selected = value === item.value;
      select.appendChild(option);
    });

    row.append(sec, main, select);
    fragment.appendChild(row);
  });
  body.appendChild(fragment);
}

function applyReview() {
  const now = new Date().toISOString();
  appState.pendingReviewItems.forEach((item, index) => {
    const select = document.querySelector(`[data-review-index="${index}"]`);
    const selected = select?.value || item.value;
    appState.checklistState[item.id] = {
      value: selected,
      source: selected === item.value ? item.source : "manual",
      quote: item.quote || "",
      rationale: item.rationale || "",
      confidence: item.confidence,
      updatedAt: now,
    };
  });
  closeModal("reviewModal");
  refreshOutputs();
  setStatus("확인된 단서를 체크리스트와 감별진단 순위에 반영했습니다.", "ok");
}

function discardReview() {
  appState.pendingReviewItems = [];
  closeModal("reviewModal");
  setStatus("추출 후보를 반영하지 않았습니다.");
}

function buildCandidateChecklist(note, vitalItems) {
  const data = appState.clinicalData;
  const appKeys = data.checklistItems.filter((item) => item.source === "appKey");
  const vitalIds = new Set(vitalItems.map((item) => item.id));
  const keywords = extractKeywords(note);
  const comprehensive = data.checklistItems
    .filter((item) => item.source === "comprehensive")
    .map((item) => ({ item, score: candidateScore(item, keywords) + (vitalIds.has(item.id) ? 20 : 0) }))
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 320)
    .map(({ item }) => item);

  const byId = new Map([...appKeys, ...comprehensive, ...vitalItems.map((item) => appState.checklistById.get(item.id))].filter(Boolean).map((item) => [item.id, item]));
  return [...byId.values()].map((item) => ({
    id: item.id,
    section: item.section,
    label: item.label,
    displayLabel: item.displayLabel || item.label,
    relatedDiagnosisNames: item.relatedDiagnosisNames || [],
    isRedRelated: item.isRedRelated,
    sourceColumn: item.sourceColumn || "",
    majorImpact: item.majorImpact || "",
    evidenceText: item.evidenceText || "",
  }));
}

function extractKeywords(note) {
  const lower = note.toLowerCase();
  const buckets = [
    { hit: /압박|쥐어짜|흉골하|pressure|substernal/.test(lower), terms: ["압박", "쥐어짜", "흉골하", "pressure", "chest pain"] },
    { hit: /방사|팔|턱|등|radiat/.test(lower), terms: ["방사", "팔", "턱", "등", "radiation"] },
    { hit: /식은땀|발한|diaphoresis|sweat/.test(lower), terms: ["식은땀", "발한", "diaphoresis"] },
    { hit: /호흡곤란|숨|dyspnea/.test(lower), terms: ["호흡곤란", "dyspnea", "저산소", "SpO2"] },
    { hit: /발열|fever/.test(lower), terms: ["발열", "fever"] },
    { hit: /ecg|st elevation|심전도/.test(lower), terms: ["ECG", "ST elevation", "심전도"] },
    { hit: /troponin|트로포닌|hs-ctn/.test(lower), terms: ["troponin", "트로포닌", "hs-cTn"] },
    { hit: /\bhtn\b|고혈압|hypertension/.test(lower), terms: ["HTN", "고혈압", "hypertension", "ACS risk"] },
    { hit: /\bdm\b|당뇨|diabetes/.test(lower), terms: ["DM", "당뇨", "diabetes", "ACS risk"] },
    { hit: /smok|흡연/.test(lower), terms: ["smoker", "흡연", "smoking", "ACS risk"] },
  ];
  return buckets.filter((bucket) => bucket.hit).flatMap((bucket) => bucket.terms.map((term) => term.toLowerCase()));
}

function candidateScore(item, keywords) {
  const prioritySections = new Set(["활력/즉시위험", "문진/증상", "위험인자/과거력", "ECG/혈액/검사", "기본평가/검사"]);
  const text = `${item.label} ${item.evidenceText} ${item.sourceColumn} ${item.majorImpact}`.toLowerCase();
  let score = 0;
  if (prioritySections.has(item.section)) score += 2;
  if (item.isRedRelated) score += 2;
  if (/가능성 상승|확률 상승|rule-in|확진/.test(`${item.majorImpact} ${item.sourceColumn}`)) score += 2;
  for (const keyword of keywords) {
    if (text.includes(keyword)) score += 5;
  }
  return score;
}

function buildVitalExtraction(vitals) {
  const rules = [
    {
      when: Number(vitals.sbp) > 0 && Number(vitals.sbp) < 90,
      terms: ["shock", "저혈압", "hypotension"],
      quote: `SBP ${vitals.sbp}`,
      rationale: "SBP < 90 기준의 저혈압 후보입니다.",
    },
    {
      when: Number(vitals.spo2) > 0 && Number(vitals.spo2) < 95,
      terms: ["spo2", "저산소", "hypox"],
      quote: `SpO2 ${vitals.spo2}%`,
      rationale: "SpO2 < 95 기준의 저산소 후보입니다.",
    },
    {
      when: Number(vitals.hr) > 100,
      terms: ["tachycardia", "tachy", "빈맥"],
      quote: `HR ${vitals.hr}`,
      rationale: "HR > 100 기준의 빈맥 후보입니다.",
    },
    {
      when: Number(vitals.rr) > 20,
      terms: ["tachypnea", "빈호흡"],
      quote: `RR ${vitals.rr}`,
      rationale: "RR > 20 기준의 빈호흡 후보입니다.",
    },
    {
      when: Number(vitals.bt) >= 38,
      terms: ["fever", "발열"],
      quote: `BT ${vitals.bt}`,
      rationale: "BT >= 38 기준의 발열 후보입니다.",
    },
    {
      when: Number(vitals.sbp) >= 180 || Number(vitals.dbp) >= 120,
      terms: ["severe bp", "고혈압 응급"],
      quote: `BP ${vitals.sbp}/${vitals.dbp}`,
      rationale: "중증 혈압 상승 후보입니다.",
    },
  ];

  const items = [];
  for (const rule of rules) {
    if (!rule.when) continue;
    for (const item of findChecklistItems(rule.terms).slice(0, 8)) {
      items.push({
        id: item.id,
        source: "vital-rule",
        section: item.section,
        label: item.displayLabel || item.label,
        value: YES,
        confidence: 0.95,
        quote: rule.quote,
        rationale: rule.rationale,
      });
    }
  }
  return mergeReviewItems(items);
}

function findChecklistItems(terms) {
  const lcTerms = terms.map((term) => term.toLowerCase());
  return appState.clinicalData.checklistItems
    .filter((item) => {
      const text = `${item.label} ${item.displayLabel}`.toLowerCase();
      return lcTerms.some((term) => text.includes(term));
    })
    .sort((a, b) => Number(b.isRedRelated) - Number(a.isRedRelated) || (a.source === "appKey" ? -1 : 1));
}

function refreshOutputs({ checklist = true } = {}) {
  appState.rankedDiagnoses = rankDiagnoses();
  renderClueChips();
  renderRiskChips();
  renderDxPanel();
  renderDxModal();
  if (checklist) renderChecklistModal();
  showResults(true);
}

function activeChecklistEntries() {
  return Object.entries(appState.checklistState)
    .map(([id, state]) => ({ id, state, item: appState.checklistById.get(id) }))
    .filter(({ item }) => item);
}

function renderClueChips() {
  const box = $("clue-kw");
  box.innerHTML = "";
  const clueSections = new Set(["활력/즉시위험", "문진/증상", "ECG/혈액/검사", "기본평가/검사", "신체진찰"]);
  const chips = activeChecklistEntries()
    .filter(({ item, state }) => clueSections.has(item.section) && (state.value === YES || isPendingState(item, state)))
    .slice(0, 22);

  chips.forEach(({ item, state }) => {
    const chip = document.createElement("span");
    chip.className = `kw${chipClass(item, state)}`;
    chip.innerHTML = '<span class="dot"></span>';
    chip.append(document.createTextNode(displayChipText(item, state)));
    box.appendChild(chip);
  });
  $("clue-empty").style.display = box.querySelector(".kw") ? "none" : "";
}

function renderRiskChips() {
  const box = $("pmh-chips");
  box.innerHTML = "";
  const riskItems = activeChecklistEntries()
    .filter(({ item, state }) => item.section === "위험인자/과거력" && state.value === YES)
    .slice(0, 16);

  if (riskItems.length) {
    riskItems.forEach(({ item }) => addRiskChip(box, item.displayLabel || item.label));
  } else {
    const text = $("note").value;
    PMH_RULES.forEach((rule) => {
      if (rule.re.test(text)) addRiskChip(box, rule.label);
    });
  }
  $("pmh-empty").style.display = box.querySelector(".kw") ? "none" : "";
}

function addRiskChip(box, text) {
  const chip = document.createElement("span");
  chip.className = "kw risk";
  chip.innerHTML = '<span class="dot"></span>';
  chip.append(document.createTextNode(text));
  box.appendChild(chip);
}

function isPendingState(item, state) {
  return state.value === UNKNOWN && /pending|대기|troponin|트로포닌/i.test(`${item.label} ${state.quote} ${state.rationale}`);
}

function chipClass(item, state) {
  if (isPendingState(item, state)) return " wait";
  if ((state.confidence !== null && state.confidence < 0.75) || state.source === "vital-rule") return " warn";
  return "";
}

function displayChipText(item, state) {
  if (state.quote && state.quote.length <= 32) return `${item.displayLabel || item.label}: ${state.quote}`;
  return item.displayLabel || item.label;
}

function renderEmptyChecklistModal() {
  $("cl-modal-body").innerHTML = '<div class="empty-hint">임상 데이터 로딩 후 체크리스트가 표시됩니다.</div>';
}

function renderChecklistModal() {
  if (!appState.clinicalData) return;
  const body = $("cl-modal-body");
  body.innerHTML = "";
  const groups = groupBySection(appState.clinicalData.checklistItems);
  const fragment = document.createDocumentFragment();

  groups.forEach(([section, items], index) => {
    const active = items.filter((item) => appState.checklistState[item.id]?.value === YES).length;
    const cat = document.createElement("div");
    cat.className = "cl-cat";

    const head = document.createElement("div");
    head.className = "cl-cat-h";
    head.append(document.createTextNode(`${index + 1}. ${section}`));
    const cnt = document.createElement("span");
    cnt.className = `cnt${active ? "" : " zero"}`;
    cnt.textContent = `${active} / ${items.length}`;
    head.appendChild(cnt);

    const bodyNode = document.createElement("div");
    bodyNode.className = "cl-cat-b";
    items.forEach((item) => bodyNode.appendChild(checklistRow(item)));

    cat.append(head, bodyNode);
    fragment.appendChild(cat);
  });
  body.appendChild(fragment);
}

function checklistRow(item) {
  const state = appState.checklistState[item.id] || { value: UNKNOWN };
  const row = document.createElement("div");
  row.className = "cl-it";

  const st = document.createElement("span");
  st.className = `st ${statusClass(state.value)}`;
  st.textContent = statusIcon(state.value);

  const label = document.createElement("span");
  label.className = "lab";
  label.textContent = item.displayLabel || item.label;
  const detail = document.createElement("span");
  detail.className = "detail-line";
  detail.textContent = detailText(item, state);
  if (detail.textContent) label.appendChild(detail);

  const select = document.createElement("select");
  select.className = "mini-select";
  select.onchange = () => manualChecklistChange(item.id, select.value);
  VALUES.forEach((value) => {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = value;
    option.selected = value === state.value;
    select.appendChild(option);
  });

  const from = document.createElement("span");
  from.className = "from";
  from.textContent = state.quote || state.source || item.sourceColumn || "";

  row.append(st, label, select, from);
  return row;
}

function detailText(item, state) {
  const related = (item.relatedDiagnosisNames || []).slice(0, 2).join(", ");
  const rationale = state.rationale || "";
  if (rationale) return rationale;
  if (related) return `관련: ${related}`;
  return item.evidenceText ? item.evidenceText.slice(0, 120) : "";
}

function manualChecklistChange(id, value) {
  const prev = appState.checklistState[id] || {};
  appState.checklistState[id] = {
    ...prev,
    value,
    source: "manual",
    updatedAt: new Date().toISOString(),
  };
  refreshOutputs({ checklist: false });
  setStatus("수동 수정이 감별진단 순위에 반영되었습니다.", "ok");
}

function groupBySection(items) {
  const map = new Map();
  items.forEach((item) => {
    const section = item.section || "기타";
    if (!map.has(section)) map.set(section, []);
    map.get(section).push(item);
  });
  return [...map.entries()].sort((a, b) => sectionRank(a[0]) - sectionRank(b[0]) || a[0].localeCompare(b[0], "ko"));
}

function sectionRank(section) {
  const idx = SECTION_ORDER.indexOf(section);
  return idx === -1 ? 999 : idx;
}

function statusClass(value) {
  if (value === YES) return "y";
  if (value === NO) return "n";
  if (value === NA) return "na";
  return "q";
}

function statusIcon(value) {
  if (value === YES) return "✓";
  if (value === NO) return "✕";
  if (value === NA) return "–";
  return "?";
}

function rankDiagnoses() {
  const activeRedSignal = activeChecklistEntries().some(({ item, state }) => item.isRedRelated && state.value === YES);
  const ranked = appState.clinicalData.diagnoses.map((diagnosis) => {
    const ids = [...(diagnosis.appKeyIds || []), ...(diagnosis.comprehensiveIds || [])];
    let score = 0;
    const evidence = [];
    const negative = [];

    ids.forEach((id) => {
      const item = appState.checklistById.get(id);
      const state = appState.checklistState[id];
      if (!item || !state) return;
      if (state.value === YES) {
        const weight = itemWeight(item);
        score += weight;
        evidence.push({
          label: item.displayLabel || item.label,
          quote: state.quote,
          weight,
        });
      } else if (state.value === NO) {
        const penalty = noPenalty(item, diagnosis);
        score -= penalty;
        if (penalty > 0.8) negative.push(item.displayLabel || item.label);
      }
    });

    if (/불안|공황|과호흡|기능성|신체증상|스트레스|panic|anxiety|hyperventilation|functional|somatic|stress/i.test(`${diagnosis.nameKr} ${diagnosis.nameEn}`) && activeRedSignal) score -= 3;
    score = Math.max(0, score);
    evidence.sort((a, b) => b.weight - a.weight);

    return {
      diagnosis,
      score,
      evidence,
      negative,
      priorityRank: priorityRank(diagnosis.priority),
      probabilityPct: probabilityPct(score, diagnosis.isRedFlag),
      status: diagnosisStatus(score, diagnosis.isRedFlag),
      riskLabel: riskLabel(diagnosis),
      nextStep: nextStep(diagnosis),
    };
  });

  return ranked.sort((a, b) => b.score - a.score || b.priorityRank - a.priorityRank || a.diagnosis.no - b.diagnosis.no);
}

function itemWeight(item) {
  let weight = item.source === "appKey" ? 2 : 1;
  const source = `${item.sourceColumn || ""} ${item.majorImpact || ""}`;
  if (/Rule-in|확진/.test(source)) weight += 4;
  if (/가능성 상승|확률 상승|의심 단서|상승/.test(source)) weight += 3;
  if (/첫 평가|기본 검사|기본평가/.test(source)) weight += 1.2;
  if (item.isRedRelated) weight += 1;
  if (/^(ECG|CXR|SpO2|BP|HR|RR|BT)$/i.test(item.label)) weight = Math.min(weight, 1.2);
  return weight;
}

function noPenalty(item, diagnosis) {
  const source = `${item.sourceColumn || ""} ${item.majorImpact || ""}`;
  if (diagnosis.isRedFlag) return /Rule-out|배제/.test(source) ? 1.0 : 0.45;
  return /Rule-out|배제/.test(source) ? 1.8 : 0.9;
}

function priorityRank(priority = "") {
  if (/Immediate/i.test(priority)) return 4;
  if (/High/i.test(priority)) return 3;
  if (/Moderate/i.test(priority)) return 2;
  return 1;
}

function probabilityPct(score, isRedFlag) {
  if (score <= 0) return isRedFlag ? 12 : 4;
  return Math.min(95, Math.round(score * 8 + (isRedFlag ? 8 : 0)));
}

function diagnosisStatus(score, isRedFlag) {
  if (isRedFlag) {
    if (score >= 8) return "Active concern";
    if (score >= 2.5) return "정보 필요";
    return "배제 전";
  }
  if (score >= 7) return "가능성 높음";
  if (score >= 3) return "가능성 중간";
  if (score > 0) return "가능성 낮음";
  return "근거 부족";
}

function riskLabel(diagnosis) {
  if (!diagnosis.isRedFlag) return "낮음";
  return /Immediate/i.test(diagnosis.priority) ? "매우 높음" : "높음";
}

function nextStep(diagnosis) {
  const source = diagnosis.initialTests || diagnosis.ruleIn || diagnosis.ruleOut || "";
  if (!source) return "임상 재평가";
  return source.replace(/\[[^\]]+\]/g, "").split(/[.;。]/)[0].slice(0, 86);
}

function renderDxPanel() {
  const content = $("dx-content");
  content.innerHTML = "";
  const red = appState.rankedDiagnoses.filter((row) => row.diagnosis.isRedFlag).slice(0, 3);
  let common = appState.rankedDiagnoses.filter((row) => !row.diagnosis.isRedFlag && (row.score > 0 || row.evidence.length)).slice(0, 3);
  if (!common.length) common = appState.rankedDiagnoses.filter((row) => !row.diagnosis.isRedFlag).slice(0, 3);

  content.appendChild(dxGroup("red", "놓치면 안 되는 위험 질환", red));
  const divider = document.createElement("div");
  divider.className = "dx-divider";
  content.appendChild(divider);
  content.appendChild(dxGroup("gray", "가능성 높은 진단", common));
}

function dxGroup(kind, title, rows) {
  const wrap = document.createElement("div");
  const head = document.createElement("div");
  head.className = `dx-group-h ${kind}`;
  head.innerHTML = '<span class="mk"></span>';
  const ttl = document.createElement("span");
  ttl.className = "ttl";
  ttl.textContent = title;
  head.appendChild(ttl);
  wrap.appendChild(head);

  const list = document.createElement("div");
  list.className = "dx-list";
  if (kind === "gray") list.style.paddingBottom = "8px";
  rows.forEach((row, index) => list.appendChild(dxCard(row, index + 1, kind === "red")));
  wrap.appendChild(list);
  return wrap;
}

function dxCard(row, rank, dangerGroup) {
  const card = document.createElement("div");
  card.className = "dx-card";
  card.onclick = () => openModal("dxModal");

  const rankNode = document.createElement("div");
  rankNode.className = `rank ${dangerGroup ? "danger" : "gray"}`;
  rankNode.textContent = String(rank);

  const main = document.createElement("div");
  main.className = "dx-main";
  const name = document.createElement("div");
  name.className = `dx-name${row.diagnosis.isRedFlag ? " danger" : ""}`;
  name.append(document.createTextNode(row.diagnosis.nameKr));
  const tag = document.createElement("span");
  tag.className = `tag ${tagClass(row.status, row.diagnosis.isRedFlag)}`;
  tag.textContent = row.status;
  name.appendChild(tag);

  const need = document.createElement("div");
  need.className = "dx-need";
  const label = document.createElement("span");
  label.className = "nl";
  label.textContent = row.diagnosis.isRedFlag ? "확진·배제" : "확인";
  need.append(label, document.createTextNode(row.nextStep));

  main.append(name, need);
  const chev = document.createElement("div");
  chev.className = "dx-chev";
  chev.textContent = "›";
  card.append(rankNode, main, chev);
  return card;
}

function tagClass(status, isRedFlag) {
  if (status === "Active concern") return "danger";
  if (status === "정보 필요" || status === "가능성 중간") return "warn";
  if (isRedFlag) return "neutral";
  if (status === "가능성 높음") return "danger";
  return "neutral";
}

function renderDxModal() {
  const body = $("dx-modal-body");
  body.innerHTML = "";
  const fragment = document.createDocumentFragment();
  appState.rankedDiagnoses.forEach((row, index) => {
    const tr = document.createElement("tr");
    tr.append(
      tdRank(index + 1, row.diagnosis.isRedFlag),
      tdName(row.diagnosis),
      tdClass(row.diagnosis.isRedFlag),
      tdProbability(row),
      tdRisk(row),
      tdText(evidenceText(row)),
      tdText(row.nextStep, "small-step"),
    );
    fragment.appendChild(tr);
  });
  body.appendChild(fragment);
}

function tdRank(rank, danger) {
  const td = document.createElement("td");
  const span = document.createElement("span");
  span.className = "rk";
  if (danger) span.style.cssText = "background:var(--danger);color:#fff";
  span.textContent = String(rank);
  td.appendChild(span);
  return td;
}

function tdName(diagnosis) {
  const td = document.createElement("td");
  td.className = `nm${diagnosis.isRedFlag ? " danger" : ""}`;
  td.textContent = diagnosis.nameKr;
  if (diagnosis.nameEn) {
    const detail = document.createElement("span");
    detail.className = "detail-line";
    detail.textContent = diagnosis.nameEn;
    td.appendChild(detail);
  }
  return td;
}

function tdClass(isRedFlag) {
  const td = document.createElement("td");
  const span = document.createElement("span");
  span.className = `cls-tag ${isRedFlag ? "danger" : "common"}`;
  span.textContent = isRedFlag ? "위험" : "일반";
  td.appendChild(span);
  return td;
}

function tdProbability(row) {
  const td = document.createElement("td");
  const div = document.createElement("div");
  div.className = "prob";
  const bar = document.createElement("div");
  bar.className = "bar";
  const fill = document.createElement("div");
  fill.className = "fill";
  fill.style.width = `${row.probabilityPct}%`;
  bar.appendChild(fill);
  const value = document.createElement("span");
  value.className = "pv";
  value.textContent = probabilityLabel(row);
  div.append(bar, value);
  td.appendChild(div);
  return td;
}

function probabilityLabel(row) {
  if (row.score >= 7) return "높음";
  if (row.score >= 3) return "중간";
  if (row.score > 0) return "낮음";
  return "부족";
}

function tdRisk(row) {
  const td = document.createElement("td");
  const span = document.createElement("span");
  span.className = "risk-dot";
  const dot = document.createElement("span");
  dot.className = "rd";
  dot.style.background = row.diagnosis.isRedFlag ? "var(--danger)" : "var(--safe)";
  span.append(dot, document.createTextNode(row.riskLabel));
  td.appendChild(span);
  return td;
}

function tdText(text, className = "") {
  const td = document.createElement("td");
  if (className) td.className = className;
  td.textContent = text;
  return td;
}

function evidenceText(row) {
  if (row.evidence.length) return row.evidence.slice(0, 4).map((item) => item.quote || item.label).join(" · ");
  if (row.negative.length) return `음성 단서: ${row.negative.slice(0, 2).join(", ")}`;
  return "현재 확인된 직접 단서가 적습니다.";
}

function showResults(on) {
  $("dx-content").style.display = on ? "" : "none";
  $("dx-empty").style.display = on ? "none" : "";
  $("dx-link").style.display = on ? "" : "none";
  $("cl-link").style.display = on && appState.clinicalData ? "" : "none";
}

function parsePmh() {
  renderRiskChips();
}

function loadExample() {
  $("note").value = EXAMPLE_NOTE;
  $("pt-name").value = EXAMPLE_PT.name;
  $("age").value = EXAMPLE_PT.age;
  $("sex").value = EXAMPLE_PT.sex;
  Object.entries(EXAMPLE_VITALS).forEach(([id, value]) => {
    $(id).value = value;
  });
  calcV();
  parsePmh();
  setStatus("예시 입력을 불러왔습니다. 임상 단서 추출을 눌러 확인 모달을 열 수 있습니다.");
}

function clearAll() {
  ["note", "pt-name", "age", "sbp", "dbp", "hr", "rr", "spo2", "bt"].forEach((id) => {
    $(id).value = "";
  });
  $("sex").value = "";
  if (appState.clinicalData) {
    resetChecklistState();
    renderChecklistModal();
  }
  $("clue-kw").innerHTML = "";
  $("pmh-chips").innerHTML = "";
  $("clue-empty").style.display = "";
  $("pmh-empty").style.display = "";
  showResults(false);
  calcV();
  setStatus("");
}

function setAbn(id, on) {
  const node = $(id);
  if (node) node.classList.toggle("abn", on);
}

function calcV() {
  const sbp = Number.parseFloat($("sbp").value);
  const dbp = Number.parseFloat($("dbp").value);
  setAbn("sbp", !Number.isNaN(sbp) && (sbp < 90 || sbp >= 140));
  setAbn("dbp", !Number.isNaN(dbp) && (dbp < 60 || dbp >= 90));
  const hr = Number.parseFloat($("hr").value);
  setAbn("hr", !Number.isNaN(hr) && (hr < 60 || hr > 100));
  const rr = Number.parseFloat($("rr").value);
  setAbn("rr", !Number.isNaN(rr) && (rr < 12 || rr > 20));
  const spo2 = Number.parseFloat($("spo2").value);
  setAbn("spo2", !Number.isNaN(spo2) && spo2 < 95);
  const bt = Number.parseFloat($("bt").value);
  setAbn("bt", !Number.isNaN(bt) && (bt < 36 || bt >= 38));
}

function openModal(id) {
  if (id === "clModal") renderChecklistModal();
  if (id === "dxModal") renderDxModal();
  $(id).classList.add("open");
  document.body.style.overflow = "hidden";
}

function closeModal(id) {
  $(id).classList.remove("open");
  document.body.style.overflow = "";
}

function bgClose(event, id) {
  if (event.target === event.currentTarget) closeModal(id);
}

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    document.querySelectorAll(".backdrop.open").forEach((modal) => modal.classList.remove("open"));
    document.body.style.overflow = "";
  }
});

Object.assign(window, {
  analyze,
  clearAll,
  calcV,
  openModal,
  closeModal,
  bgClose,
  parsePmh,
  loadExample,
  applyReview,
  discardReview,
  manualChecklistChange,
});

init();
