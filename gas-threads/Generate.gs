/**
 * 投稿文の生成（第2弾。要件 §3.8）。
 *
 * 実装の形は、既存の Gemini 呼び出し（note-auto-fill-gas の
 * geminiArticleGenerator.js）に合わせてある。定数の切り方・キーの取得と
 * 渡し方（URL の ?key= パラメータ）・contents/generationConfig の組み立て・
 * Logger の出し方・エラーメッセージの形式が同じ。
 *
 * 生成結果は**下書きにも履歴にも自動では書かない**。テキストエリアに
 * 入れて人が確認・編集し、保存・投稿は本人の操作で行う
 * （「最後は人が押す」という v2.0 の方針を生成にも通す）。
 */

// ============================================================
// 設定値
// ============================================================

/**
 * APIキーを保存しているスクリプト プロパティの名前。
 */
var GEMINI_API_KEY_PROPERTY = 'GEMINI_API_KEY';

/**
 * 使用するGeminiのモデル名。
 * 速度と費用のバランスが良いものを既定にしている
 * （note-auto-fill-gas と同じ選定理由）。
 * スクリプト プロパティ GEMINI_MODEL で差し替えられる。
 */
var GEMINI_DEFAULT_MODEL = 'gemini-2.0-flash';

/**
 * Gemini APIの呼び出し先（モデル名を除いた部分）。
 */
var GEMINI_ENDPOINT_BASE = 'https://generativelanguage.googleapis.com/v1beta/models/';

// ============================================================
// APIキーの取得
// ============================================================

/**
 * スクリプト プロパティからGemini APIキーを読み出す関数。
 *
 * @return {string} APIキー
 * @throws {Error} 未設定の場合（設定手順を含むメッセージを出す）
 */
function getGeminiApiKey_() {
  var apiKey = PropertiesService
    .getScriptProperties()
    .getProperty(GEMINI_API_KEY_PROPERTY);

  if (!apiKey) {
    throw new Error(
      'Gemini APIキーが設定されていません。' +
        'エディタ左下「プロジェクトの設定」→「スクリプト プロパティ」で' +
        '「' + GEMINI_API_KEY_PROPERTY + '」という名前でキーを登録してください。'
    );
  }

  return apiKey;
}

function geminiModel_() {
  var model = PropertiesService.getScriptProperties().getProperty('GEMINI_MODEL');
  return model && String(model).trim() ? String(model).trim() : GEMINI_DEFAULT_MODEL;
}

// ============================================================
// プロンプトの組み立て
// ============================================================

/**
 * Geminiへ送る指示文（プロンプト）を組み立てる関数。
 *
 * 事実の創作を防ぐため、
 * 「入力情報に無いことは書かない」という指示を明示している
 * （note-auto-fill-gas と同じ方針）。
 *
 * @param {string} theme - テーマ・指示
 * @return {string} プロンプト
 */
function buildThreadsPostPrompt_(theme) {
  return 'あなたは、Threads（テキストSNS）への投稿文を書く日本語のライターです。\n' +
    '以下のテーマ・指示をもとに、投稿文を1本作成してください。\n' +
    '\n' +
    '# 投稿の方針\n' +
    '- 全体で' + THREADS_TEXT_LIMIT + '文字以内にすること。\n' +
    '- 過度に煽らないこと。「衝撃」のような誇張表現は使わないこと。\n' +
    '- テーマ・指示に無い数字・固有名詞・具体的なエピソードを追加しないこと（創作の禁止）。\n' +
    '- ハッシュタグは指示された場合のみ付けること。\n' +
    '- 前置き・後書き・引用符・コードブロックを付けず、投稿文そのものだけを出力すること。\n' +
    '\n' +
    '# テーマ・指示\n' +
    theme;
}

// ============================================================
// Gemini APIの呼び出し
// ============================================================

/**
 * Gemini APIを呼び出し、生成された文章を返す関数。
 *
 * @param {string} prompt - 送る指示文
 * @return {string} 生成された文章
 * @throws {Error} 通信や応答形式に問題があった場合
 */
function callGeminiApi_(prompt) {
  var apiKey = getGeminiApiKey_();
  var model = geminiModel_();

  var payload = {
    contents: [
      {
        role: 'user',
        parts: [{ text: prompt }]
      }
    ],
    generationConfig: {
      // 数値が小さいほど、事実に沿った落ち着いた文章になりやすい
      temperature: 0.4
    }
  };

  // muteHttpExceptions: true にすると、エラー応答でも例外を投げず
  // 中身を読めるようになる。原因を確認するために必要。
  var options = {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  };

  Logger.log('[gemini] Gemini APIを呼び出します。モデル: ' + model);

  // APIキーはURLのパラメータとして渡す（note-auto-fill-gas と同じ）
  var response = UrlFetchApp.fetch(
    GEMINI_ENDPOINT_BASE + model + ':generateContent?key=' + encodeURIComponent(apiKey),
    options
  );

  var statusCode = response.getResponseCode();
  var responseText = response.getContentText();

  Logger.log('[gemini] HTTPステータス: ' + statusCode);

  if (statusCode !== 200) {
    // エラー内容の先頭だけ出す（全文は長すぎることがある）
    throw new Error(
      'Gemini APIがエラーを返しました（HTTP ' + statusCode + '）: ' +
        responseText.slice(0, 300)
    );
  }

  var json = JSON.parse(responseText);

  // 応答の構造：candidates[0].content.parts[0].text に生成文が入る。
  // 安全フィルタで止められた場合などは candidates が空になる。
  if (!json.candidates || json.candidates.length === 0) {
    throw new Error(
      'Gemini APIが候補を返しませんでした。応答: ' + responseText.slice(0, 300)
    );
  }

  var candidate = json.candidates[0];

  if (
    !candidate.content ||
    !candidate.content.parts ||
    candidate.content.parts.length === 0
  ) {
    throw new Error(
      'Gemini APIの応答に本文が含まれていません。' +
        '終了理由: ' + (candidate.finishReason || '不明')
    );
  }

  var text = candidate.content.parts[0].text;

  Logger.log('[gemini] 生成された文字数: ' + String(text).length);

  return text;
}

// ============================================================
// 応答の整形
// ============================================================

/**
 * 応答からコードフェンス（``` …```）や前後の空白を取り除く。
 * 指示していても稀に付くため、備えておく（note-auto-fill-gas の
 * extractJsonFromText_ と同じ考え方）。
 */
function cleanGeneratedText_(text) {
  return String(text || '')
    .trim()
    .replace(/^```[a-z]*\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();
}

// ============================================================
// 画面から呼ぶ入口
// ============================================================

/**
 * テーマ・指示から Threads 向けの投稿文を1本作る。
 * 成否は戻り値で返す（postNow と同じ流儀。例外は画面まで飛ばさない）。
 */
function generatePostText(instruction) {
  try {
    var theme = String(instruction == null ? '' : instruction);

    if (!theme.trim()) {
      throw new Error('テーマ・指示が空です');
    }

    var text = cleanGeneratedText_(callGeminiApi_(buildThreadsPostPrompt_(theme)));

    if (!text) {
      throw new Error('生成結果が空でした。指示を変えてお試しください');
    }

    return { ok: true, text: text };
  } catch (error) {
    return { ok: false, error: String(error.message || error) };
  }
}
