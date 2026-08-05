/*
 * 両面の撮影フロー（要件定義書 §FR-03・FR-04、v3.1）。
 *
 * ==================================================================
 * ここに DOM を持ち込まない
 * ==================================================================
 * 「いま何を撮る画面か」を決めるだけの純粋な状態遷移。
 * prerequisites.js と同じ理由で、画面を組み立てずに確かめられる形に
 * してある。画面への反映は app.js。
 * ==================================================================
 *
 * ==================================================================
 * 順に取得する（1画面に2枠を並べない）
 * ==================================================================
 * §FR-03 の決定。スマートフォンで片手で扱うときに「いま何を撮れば
 * よいか」が一意に決まる。
 *
 * **裏面なしが多数派**である（名刺の裏は空白か、英語表記の複製）。
 * 多数派の操作を最短にし、裏面は明示的に選んだ人だけが通る形にする。
 * そのため「裏面なしで進む」を既定の導線として並べる。
 * ==================================================================
 */

export const CaptureStep = Object.freeze({
  /* 表面を撮る。**必須。** */
  FRONT: 'FRONT',
  /* 裏面も読み取るか尋ねる。 */
  ASK_BACK: 'ASK_BACK',
  /* 裏面を撮る。 */
  BACK: 'BACK',
  /* 読み取りを開始できる。 */
  READY: 'READY',
});

/*
 * 裏面をどうするか、利用者がまだ選んでいないことを null で表す。
 *
 * **false（裏面なしで進む）と null（未回答）を分ける。**
 * 同じにすると、尋ねる前から「なし」と決まっていることになり、
 * ASK_BACK の画面が出せない。
 */
export function createCaptureState() {
  return Object.freeze({ front: null, back: null, wantsBack: null });
}

export function currentStep(state) {
  if (!state?.front) {
    return CaptureStep.FRONT;
  }

  if (state.wantsBack === null) {
    return CaptureStep.ASK_BACK;
  }

  if (state.wantsBack === true && !state.back) {
    return CaptureStep.BACK;
  }

  return CaptureStep.READY;
}

/* ---------- 遷移（いずれも新しい状態を返す。元を書き換えない） ---------- */

/*
 * 表面を差し替える。
 *
 * **裏面の回答は保つ。** 表面だけ撮り直したいときに、裏面まで
 * やり直させない（§FR-04「読み取り開始前は、表面・裏面のどちらも
 * 差し替えられる」）。
 */
export function setFront(state, image) {
  return Object.freeze({ ...state, front: image ?? null });
}

export function setBack(state, image) {
  return Object.freeze({ ...state, back: image ?? null, wantsBack: true });
}

/* 「裏面なしで進む」。 */
export function skipBack(state) {
  return Object.freeze({ ...state, back: null, wantsBack: false });
}

/* 「裏面も読み取る」。 */
export function wantBack(state) {
  return Object.freeze({ ...state, wantsBack: true });
}

/*
 * 裏面を取り消す（§FR-03 の最後の項）。
 *
 * **画像だけでなく回答も戻す。** 画像だけ消すと BACK の画面に
 * 留まり続け、「裏面なしで進む」を選び直せない。
 */
export function clearBack(state) {
  return Object.freeze({ ...state, back: null, wantsBack: null });
}

/*
 * 表面を取り消す。
 *
 * **裏面も一緒に捨てる。** 表面が無ければ登録できないので、
 * 裏面だけ残しても使い道がない。残すと「裏面だけある」という
 * 表現できない状態を作ることになる。
 */
export function clearAll() {
  return createCaptureState();
}

/* ---------- 画面に出す言葉 ---------- */

export function describeStep(step) {
  switch (step) {
    case CaptureStep.FRONT:
      return {
        title: '表面を撮影してください',
        text: '名刺全体が入るように撮ってください。文字が読める向きで構いません。',
      };
    case CaptureStep.ASK_BACK:
      return {
        title: '裏面も読み取りますか？',
        text: '裏面に会社名や氏名がある名刺だけで結構です。空白や模様だけなら不要です。',
      };
    case CaptureStep.BACK:
      return {
        title: '裏面を撮影してください',
        text: '表面と同じように、全体が入るように撮ってください。',
      };
    default:
      return {
        title: '読み取りの準備ができました',
        text: '内容を確かめて、読み取りを開始してください。',
      };
  }
}

/* 台帳へ書くときの has_back（§11.2）。 */
export function hasBack(state) {
  return Boolean(state?.back);
}
