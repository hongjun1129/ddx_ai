# 흉통 평가 워크플로우 데모

현재 폴더의 `chest-pain-workflow-v8_1.html`과 두 XLSX 원천 파일을 기반으로 동작하는 정적 데모 앱입니다. 기존 HTML/CSS 디자인은 유지하고, XLSX에서 생성한 JSON 데이터로 체크리스트와 감별진단 순위를 렌더링합니다.

## 실행

```bash
npm install
npm run build
npm run dev
```

브라우저에서 `http://localhost:3000`으로 접속합니다.

PowerShell에서 `npm.ps1` 실행 정책 오류가 나면 아래처럼 `npm.cmd`를 사용합니다.

```powershell
npm.cmd install
npm.cmd run build
npm.cmd run dev
```

## 단서 추출

Vercel 배포에서는 서버리스 함수를 사용하지 않고 브라우저 안에서 mock 단서 추출을 수행합니다. 체크리스트 반영은 기존처럼 의사 확인 모달을 거친 뒤에만 적용됩니다.

실제 LLM 서버 연동은 Vercel 화면 확인이 안정화된 뒤 별도 API로 다시 붙이는 구조가 안전합니다.

## Vercel 배포

`vercel.json`은 Vercel 빌드 명령을 `npm run build`, 출력 폴더를 `public`으로 고정합니다. 이 배포는 순수 정적 사이트이므로 Vercel Serverless Function을 만들지 않습니다.

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
