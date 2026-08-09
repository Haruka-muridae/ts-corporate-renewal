/*
 * Sheets.gs — シートの読み書き
 *
 * ==================================================================
 * このファイルだけが SpreadsheetApp を触る
 * ==================================================================
 * `lib/pipeline/db/` で IndexedDB を1ファイルに閉じたのと同じ理由。
 * Themes.gs / Versions.gs / Scenes.gs は**ポート**に対して書き、
 * SpreadsheetApp を知らない。
 *
 * おかげで:
 *   - 採用・派生のロジックを Node 上で検証できる
 *     （tests/unit/pipeline-gas.mjs が偽シートを差す）
 *   - 実シートを汚さずにテストできる
 *
 * ==================================================================
 * 列は「位置」ではなく「見出し名」で読む
 * ==================================================================
 * このシートは**発注者が手で開いて眺める**（原本は Sheets、という設計原則）。
 * 手で列を並べ替えたり、間に列を挿したりすることは普通に起こる。
 * 位置で読むと、そのとき静かに壊れて別の列を読み書きする。
 *
 * そこで**1行目の見出しから列位置を引く。** 必要な見出しが無ければ、
 * 何が足りないかを名指しで落とす。
 * ==================================================================
 */

/** シートの列定義を返す。未定義のシート名はここで落とす。 */
function IssoSheets_columns(sheetName) {
  var columns = ISSO_COLUMNS[sheetName];

  if (!columns) {
    throw new Error('未定義のシートです: ' + sheetName);
  }

  return columns;
}

/**
 * セルの値を宣言した型へそろえる。
 *
 * **Sheets は同じ列でも boolean を返したり文字列を返したりする。**
 * TRUE と入力すれば boolean、'TRUE' と入力すれば文字列で返る。
 * ここで吸収しないと、採用フラグの判定がシートの編集の仕方に依存する。
 */
function IssoSheets_coerce(type, value) {
  if (type === 'boolean') {
    if (value === true) {
      return true;
    }

    if (value === false || value === null || value === undefined || value === '') {
      return false;
    }

    var text = String(value).replace(/^\s+|\s+$/g, '').toLowerCase();

    return text === 'true' || text === 'はい' || text === '1';
  }

  if (type === 'number') {
    if (value === null || value === undefined || value === '') {
      return 0;
    }

    var num = Number(value);

    /* 数字でないものが入っていたら 0 にする。NaN を下流へ流さない。 */
    return isNaN(num) ? 0 : num;
  }

  if (value === null || value === undefined) {
    return '';
  }

  var text = String(value);

  /*
   * 書き込み時に付けた「'」を外す（`IssoSheets_toCell` の対）。
   *
   * **「'=」の並びに限る。** Sheets は普通この「'」を返してこないので
   * 多くの場合ここは素通りするが、環境差で付いてきたときに
   * 本文の先頭が変わってしまうのを防ぐ。
   *
   * 引き換えに、**本当に「'=」で始まる文章**は「'」が1つ落ちる。
   * 区切り記号で始まる文章（「=== …」）を守るほうが実害が大きいと判断した。
   */
  return text.indexOf("'=") === 0 ? text.slice(1) : text;
}

/** 書き込む値。boolean は Sheets の TRUE/FALSE として素直に入る。 */
function IssoSheets_toCell(type, value) {
  if (type === 'boolean') {
    return value === true;
  }

  if (type === 'number') {
    var num = Number(value);
    return isNaN(num) ? 0 : num;
  }

  var text = value === null || value === undefined ? '' : String(value);

  /*
   * ==================================================================
   * 「=」で始まる文字列を数式にしない
   * ==================================================================
   * Sheets は setValue に渡された「=」始まりの文字列を**数式として解釈する。**
   * 一想が扱う文章は区切り記号で始まることがあり
   * （「=== タイトル候補 ===」「=== シーン1 ===」）、そのまま書くと
   * **セルが #ERROR! になって本文が失われる。**
   *
   * 2026-08-09 に note の本文で実際に起きた。取り込んだ2案とも
   * 本文が「#ERROR!」の7文字になり、**元の文章は復元できなかった**
   * （generation_queue.result 側も同じ経路で壊れていたため）。
   *
   * 先頭に「'」を付けると Sheets は文字列として扱う。これは Sheets の
   * 記法であって値の一部ではないため、読み戻しでは付いてこない。
   * ただし環境差で付いてくる場合に備え、`IssoSheets_coerce` 側で
   * **「'=」の並びに限って**外している（往復で必ず元へ戻る）。
   * ==================================================================
   */
  return text.indexOf('=') === 0 ? "'" + text : text;
}

/**
 * 見出し行から「列キー → 位置」の対応を作る。
 *
 * 定義にある見出しが1つでも欠けていたら落とす。**黙って空で読まない。**
 */
function IssoSheets_headerIndex(sheetName, headerRow) {
  var columns = IssoSheets_columns(sheetName);
  var index = {};
  var missing = [];
  var i;

  for (i = 0; i < headerRow.length; i++) {
    var name = String(headerRow[i] === null || headerRow[i] === undefined ? '' : headerRow[i])
      .replace(/^\s+|\s+$/g, '');

    if (name !== '') {
      index[name] = i;
    }
  }

  for (i = 0; i < columns.length; i++) {
    if (index[columns[i].key] === undefined) {
      missing.push(columns[i].key);
    }
  }

  if (missing.length > 0) {
    throw new Error(
      'シート「' + sheetName + '」に必要な見出しがありません: ' + missing.join(', ')
      + '。1行目の見出しを確認してください。'
    );
  }

  return index;
}

/** 行 → オブジェクト。 */
function IssoSheets_toObject(sheetName, headerIndex, row) {
  var columns = IssoSheets_columns(sheetName);
  var record = {};

  for (var i = 0; i < columns.length; i++) {
    var column = columns[i];
    record[column.key] = IssoSheets_coerce(column.type, row[headerIndex[column.key]]);
  }

  return record;
}

/**
 * オブジェクト → 行。
 *
 * **見出しの並び順に合わせて書く。** 定義の順ではない。
 * 手で列を並べ替えられていても壊れないようにするため。
 */
function IssoSheets_toRow(sheetName, headerIndex, record, width) {
  var columns = IssoSheets_columns(sheetName);
  var row = [];
  var i;

  for (i = 0; i < width; i++) {
    row.push('');
  }

  for (i = 0; i < columns.length; i++) {
    var column = columns[i];
    row[headerIndex[column.key]] = IssoSheets_toCell(column.type, record[column.key]);
  }

  return row;
}

/* ------------------------------------------------------------------
 * テーブルアクセサ（実装は2つ）
 * ------------------------------------------------------------------
 * 契約:
 *   read(name)              -> 行の配列（1行目は見出し）。無ければ null
 *   create(name, header)    -> シートを作り見出しを書く
 *   append(name, row)       -> 末尾に1行足す
 *   writeAt(name, index, row) -> index 行目（0=見出し）を差し替える
 *   deleteAt(name, index)   -> index 行目を消す
 * ------------------------------------------------------------------ */

/** 実シート。**SpreadsheetApp を触るのはここだけ。** */
function IssoSheets_spreadsheetTables(spreadsheetId) {
  var book = SpreadsheetApp.openById(spreadsheetId);

  function sheetOf(name) {
    var sheet = book.getSheetByName(name);

    if (!sheet) {
      throw new Error('シートがありません: ' + name + '。初期化を実行してください。');
    }

    return sheet;
  }

  return {
    read: function (name) {
      var sheet = book.getSheetByName(name);

      if (!sheet) {
        return null;
      }

      /* 空のシートでも getDataRange は1行返すため、行数で判定する。 */
      if (sheet.getLastRow() === 0) {
        return [];
      }

      return sheet.getDataRange().getValues();
    },
    create: function (name, header) {
      var sheet = book.getSheetByName(name) || book.insertSheet(name);

      sheet.getRange(1, 1, 1, header.length).setValues([header]);
      sheet.setFrozenRows(1);

      return sheet;
    },
    append: function (name, row) {
      sheetOf(name).appendRow(row);
    },
    writeAt: function (name, index, row) {
      sheetOf(name).getRange(index + 1, 1, 1, row.length).setValues([row]);
    },
    deleteAt: function (name, index) {
      sheetOf(name).deleteRow(index + 1);
    }
  };
}

/**
 * メモリ実装。**テスト用。**
 *
 * 実シートを汚さずに、採用・派生などのロジックを検証するために使う。
 * `seed` は { シート名: 行の配列 }。見出し行を含める。
 */
function IssoSheets_memoryTables(seed) {
  var data = {};

  if (seed) {
    for (var name in seed) {
      if (Object.prototype.hasOwnProperty.call(seed, name)) {
        data[name] = seed[name].map(function (row) { return row.slice(); });
      }
    }
  }

  return {
    read: function (name) {
      return data[name] === undefined ? null : data[name].map(function (r) { return r.slice(); });
    },
    create: function (name, header) {
      data[name] = [header.slice()];
    },
    append: function (name, row) {
      data[name].push(row.slice());
    },
    writeAt: function (name, index, row) {
      data[name][index] = row.slice();
    },
    deleteAt: function (name, index) {
      data[name].splice(index, 1);
    },
    /** テストから中身を覗くための口。ポートの契約には含めない。 */
    dump: function () { return data; }
  };
}

/* ------------------------------------------------------------------
 * ポート
 * ------------------------------------------------------------------ */

/**
 * テーブルアクセサからポートを作る。
 *
 * @param {object} tables IssoSheets_spreadsheetTables か IssoSheets_memoryTables
 */
function IssoSheets_create(tables) {
  /** 見出し行と本体をまとめて取る。 */
  function load(sheetName) {
    var rows = tables.read(sheetName);

    if (rows === null) {
      throw new Error('シートがありません: ' + sheetName + '。初期化を実行してください。');
    }

    if (rows.length === 0) {
      throw new Error('シート「' + sheetName + '」に見出し行がありません。初期化を実行してください。');
    }

    return { header: rows[0], rows: rows, index: IssoSheets_headerIndex(sheetName, rows[0]) };
  }

  /** 主キーで行位置を探す。見つからなければ -1。 */
  function locate(sheetName, loaded, id) {
    var keyColumn = ISSO_PRIMARY_KEY[sheetName];
    var at = loaded.index[keyColumn];

    for (var i = 1; i < loaded.rows.length; i++) {
      if (String(loaded.rows[i][at]) === String(id)) {
        return i;
      }
    }

    return -1;
  }

  return {
    /**
     * 定義どおりのシートと見出しを用意する。**既にあるものは触らない。**
     * 何度実行しても同じ結果になる（gas-auth の setupAuthSystem と同じ考え方）。
     */
    ensureSheets: function () {
      var created = [];

      for (var sheetName in ISSO_COLUMNS) {
        if (!Object.prototype.hasOwnProperty.call(ISSO_COLUMNS, sheetName)) {
          continue;
        }

        var rows = tables.read(sheetName);

        if (rows !== null && rows.length > 0) {
          /* 既にある。見出しが足りているかだけ確かめる（足りなければ落ちる）。 */
          IssoSheets_headerIndex(sheetName, rows[0]);
          continue;
        }

        var header = IssoSheets_columns(sheetName).map(function (column) {
          return column.key;
        });

        tables.create(sheetName, header);
        created.push(sheetName);
      }

      return created;
    },

    getAll: function (sheetName) {
      var loaded = load(sheetName);
      var keyColumn = ISSO_PRIMARY_KEY[sheetName];
      var at = loaded.index[keyColumn];
      var out = [];

      for (var i = 1; i < loaded.rows.length; i++) {
        /*
         * 主キーが空の行は飛ばす。手で編集したあとに空行が残ることがあり、
         * それを1件として数えると件数がずれる。
         */
        if (String(loaded.rows[i][at]).replace(/^\s+|\s+$/g, '') === '') {
          continue;
        }

        out.push(IssoSheets_toObject(sheetName, loaded.index, loaded.rows[i]));
      }

      return out;
    },

    findById: function (sheetName, id) {
      var all = this.getAll(sheetName);
      var keyColumn = ISSO_PRIMARY_KEY[sheetName];

      for (var i = 0; i < all.length; i++) {
        if (all[i][keyColumn] === String(id)) {
          return all[i];
        }
      }

      return null;
    },

    findBy: function (sheetName, key, value) {
      var all = this.getAll(sheetName);
      var out = [];

      for (var i = 0; i < all.length; i++) {
        if (String(all[i][key]) === String(value)) {
          out.push(all[i]);
        }
      }

      return out;
    },

    insert: function (sheetName, record) {
      var loaded = load(sheetName);

      tables.append(
        sheetName,
        IssoSheets_toRow(sheetName, loaded.index, record, loaded.header.length)
      );

      return record;
    },

    update: function (sheetName, id, patch) {
      var loaded = load(sheetName);
      var at = locate(sheetName, loaded, id);

      if (at === -1) {
        throw new Error(sheetName + ' に ' + id + ' がありません。');
      }

      var current = IssoSheets_toObject(sheetName, loaded.index, loaded.rows[at]);
      var keyColumn = ISSO_PRIMARY_KEY[sheetName];

      for (var key in patch) {
        /* 主キーは書き換えさせない。追跡できなくなる。 */
        if (Object.prototype.hasOwnProperty.call(patch, key) && key !== keyColumn) {
          current[key] = patch[key];
        }
      }

      tables.writeAt(
        sheetName, at,
        IssoSheets_toRow(sheetName, loaded.index, current, loaded.header.length)
      );

      return current;
    },

    remove: function (sheetName, id) {
      var loaded = load(sheetName);
      var at = locate(sheetName, loaded, id);

      if (at !== -1) {
        tables.deleteAt(sheetName, at);
      }
    },

    /**
     * ある列の値が一致する行をまとめて入れ替える。
     *
     * 台本を作り直したときのシーンの差し替えに使う。
     * **後ろから消す**（前から消すと、消したぶん位置がずれる）。
     */
    replaceBy: function (sheetName, key, value, records) {
      var loaded = load(sheetName);
      var at = loaded.index[key];
      var targets = [];
      var i;

      for (i = 1; i < loaded.rows.length; i++) {
        if (String(loaded.rows[i][at]) === String(value)) {
          targets.push(i);
        }
      }

      for (i = targets.length - 1; i >= 0; i--) {
        tables.deleteAt(sheetName, targets[i]);
      }

      for (i = 0; i < records.length; i++) {
        this.insert(sheetName, records[i]);
      }

      return records;
    }
  };
}

/** 本番用のポート。画面から呼ぶ入口はこれを使う。 */
function IssoSheets_open() {
  return IssoSheets_create(IssoSheets_spreadsheetTables(IssoConfig_spreadsheetId()));
}
