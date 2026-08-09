/*
 * jsrsasign（MIT License）の同梱先。
 *
 * ==================================================================
 * このファイルには、まだ本体が入っていない
 * ==================================================================
 * jsrsasign 本体（約500KB）はリポジトリに置かない。利用者が自分の
 * Apps Script プロジェクトへ貼り付ける（README.md §2 の手順）。
 *
 *   1. https://github.com/kjur/jsrsasign の releases から
 *      `jsrsasign-all-min.js` を入手する
 *   2. **下の「ここから下へ貼る」より下**へ、その中身をまるごと貼る
 *   3. メニュー「録音通知」→「jsrsasign を検証」を実行し、成功を確かめる
 *
 * jsrsasign is released under the MIT License.
 * Copyright (c) 2010-2024 Kenji Urushima (kenji.urushima@gmail.com)
 * ライセンス全文は配布物の先頭に含まれる。貼り付けるときに消さないこと。
 * ==================================================================
 */

/* --- GAS用スタブ（jsrsasign本体より前に評価される必要がある） --- */
// window.crypto.getRandomValues を Utilities.getUuid() ベースで実装しているのは、
// ECDSA署名のnonceに弱い乱数（Math.randomフォールバック）を使わせないため。
var navigator = { appName: "Google Apps Script" };
var window = {
  crypto: {
    getRandomValues: function (arr) {
      var i = 0;
      while (i < arr.length) {
        var hex = Utilities.getUuid().replace(/-/g, "");
        for (var j = 0; j + 1 < hex.length && i < arr.length; j += 2) {
          arr[i++] = parseInt(hex.substr(j, 2), 16);
        }
      }
      return arr;
    }
  }
};
// --- スタブここまで。以下に jsrsasign 本体を貼り付ける ---

/* ================================================================== */
/* ここから下へ jsrsasign-all-min.js の中身を貼る                       */
/* ================================================================== */
