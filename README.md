# 흉통 평가 워크플로우 데모

현재 폴더의 `chest-pain-workflow-v8_1.html`과 두 XLSX 원천 파일을 기반으로 동작하는 정적 데모 앱입니다. 기존 HTML/CSS 디자인은 유지하고, XLSX에서 생성한 JSON 데이터로 체크리스트와 감별진단 순위를 렌더링합니다.

## 실행

```bash
npm install
npm run build
npm start
```

브라우저에서 `http://localhost:3000`으로 접속합니다.

PowerShell에서 `npm.ps1` 실행 정책 오류가 나면 아래처럼 `npm.cmd`를 사용합니다.

```powershell
npm.cmd install
npm.cmd run build:data
npm.cmd start
```

## LLM 추출

브라우저는 API 키를 직접 사용하지 않습니다. 로컬 실행에서는 `server.js`의 `/api/extract-clues`가, Vercel 배포에서는 `api/extract-clues.js` 서버리스 함수가 서버에서 LLM을 호출합니다.

1. `.env.example`을 참고해 `.env`를 만듭니다.
2. `LLM_API_KEY`와 `LLM_MODEL`을 채웁니다.
3. `npm start`로 서버를 실행합니다.

`LLM_API_KEY`가 비어 있으면 개발용 mock 추출이 사용됩니다. mock 결과도 의사 확인 모달을 거친 뒤에만 체크리스트 상태에 반영됩니다.

## Vercel 배포

`vercel.json`은 Vercel 빌드 명령을 `npm run build`, 출력 폴더를 `public`으로 고정합니다. `/api/extract-clues`는 독립형 Vercel 서버리스 함수로 동작하므로 Vercel에서 `npm start`를 실행하도록 설정하지 않아도 됩니다.

실제 LLM 호출을 쓰려면 Vercel Project Settings의 Environment Variables에 `LLM_API_KEY` 또는 `OPENAI_API_KEY`를 추가합니다. 키가 없으면 mock 추출로 동작합니다.

## 데이터 생성

`scripts/build-clinical-data.mjs`는 외부 패키지 없이 XLSX 내부 XML을 읽어 `data/chest-pain-clinical-data.json`을 생성합니다.

생성 JSON에는 다음이 포함됩니다.

- 90개 감별진단 노드
- AppKey 및 Comprehensive 체크리스트 항목
- 진단-체크리스트 ID 매핑
- red flag gate
- 구현 규칙과 ACS 처분 경로

## 안전 원칙

이 앱은 임상 의사결정 보조 데모입니다. LLM은 체크리스트 항목 추출에만 사용하고, 감별진단 순위는 XLSX 매핑과 deterministic scoring으로 계산합니다. 최종 진단과 처치는 의료진 판단이 우선입니다.
