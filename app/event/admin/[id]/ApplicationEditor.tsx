"use client";

import { useActionState } from "react";

import {
  resendConfirmationMail,
  updateApplication,
  type EditState,
} from "../actions";

/*
 * 申込者情報の編集と、参加確定メールの再送（仕様書7.2、受入条件11）。
 *
 * 譲渡はセルフサービスにしない運用のため、管理者がここで書き換える。
 * 受付番号と支払額は変えない。
 */

const initialState: EditState = { error: "", message: "" };

type Props = {
  applicationId: string;
  initial: {
    name: string;
    nameKana: string;
    email: string;
    phone: string;
    company: string;
    department: string;
    jobTitle: string;
    adminMemo: string;
  };
  canResend: boolean;
};

function Notice({ state }: { state: EditState }) {
  if (state.error) {
    return (
      <p className="apply-form__alert" role="alert">
        {state.error}
      </p>
    );
  }

  if (state.message) {
    return (
      <p className="admin-notice" role="status">
        {state.message}
      </p>
    );
  }

  return null;
}

export function ApplicationEditor({ applicationId, initial, canResend }: Props) {
  const [editState, editAction, editPending] = useActionState(
    updateApplication,
    initialState,
  );
  const [mailState, mailAction, mailPending] = useActionState(
    resendConfirmationMail,
    initialState,
  );

  return (
    <>
      <section className="admin-section">
        <h2 className="admin-section__title">申込者情報の編集（譲渡対応）</h2>

        <Notice state={editState} />

        <form className="admin-form" action={editAction}>
          <input type="hidden" name="applicationId" value={applicationId} />

          <div className="form-field">
            <label className="form-field__label" htmlFor="edit-name">
              氏名
            </label>
            <input
              className="form-field__input"
              id="edit-name"
              name="name"
              type="text"
              defaultValue={initial.name}
              required
            />
          </div>

          <div className="form-field">
            <label className="form-field__label" htmlFor="edit-name-kana">
              フリガナ
            </label>
            <input
              className="form-field__input"
              id="edit-name-kana"
              name="nameKana"
              type="text"
              defaultValue={initial.nameKana}
              required
            />
          </div>

          <div className="form-field">
            <label className="form-field__label" htmlFor="edit-email">
              メールアドレス
            </label>
            <input
              className="form-field__input"
              id="edit-email"
              name="email"
              type="email"
              defaultValue={initial.email}
              required
            />
          </div>

          <div className="form-field">
            <label className="form-field__label" htmlFor="edit-phone">
              電話番号
            </label>
            <input
              className="form-field__input"
              id="edit-phone"
              name="phone"
              type="tel"
              defaultValue={initial.phone}
              required
            />
          </div>

          <div className="form-field">
            <label className="form-field__label" htmlFor="edit-company">
              会社名
            </label>
            <input
              className="form-field__input"
              id="edit-company"
              name="company"
              type="text"
              defaultValue={initial.company}
              required
            />
          </div>

          <div className="form-field">
            <label className="form-field__label" htmlFor="edit-department">
              部署名
            </label>
            <input
              className="form-field__input"
              id="edit-department"
              name="department"
              type="text"
              defaultValue={initial.department}
            />
          </div>

          <div className="form-field">
            <label className="form-field__label" htmlFor="edit-job-title">
              役職名
            </label>
            <input
              className="form-field__input"
              id="edit-job-title"
              name="jobTitle"
              type="text"
              defaultValue={initial.jobTitle}
            />
          </div>

          <div className="form-field">
            <label className="form-field__label" htmlFor="edit-memo">
              管理者メモ
            </label>
            <textarea
              className="form-field__input admin-form__textarea"
              id="edit-memo"
              name="adminMemo"
              rows={4}
              defaultValue={initial.adminMemo}
            />
            <p className="form-field__note">
              当日徴収した差額など、システムに反映しない記録はここに残します。
            </p>
          </div>

          <div className="form-field form-choice">
            <label className="form-choice__item">
              <input type="checkbox" name="isTransfer" />
              <span>
                譲渡として記録する（譲渡元の氏名・メールと日時を履歴に残します。
                受付番号と支払金額は変わりません）
              </span>
            </label>
          </div>

          <button className="btn btn--primary" type="submit" disabled={editPending}>
            {editPending ? "保存中…" : "保存する"}
          </button>
        </form>
      </section>

      <section className="admin-section">
        <h2 className="admin-section__title">参加確定メールの再送</h2>

        <Notice state={mailState} />

        <p className="admin__note">
          現在登録されているメールアドレス宛に、参加確定メールを送り直します。
          譲渡で宛先を変えたあとに使います。
        </p>

        <form action={mailAction}>
          <input type="hidden" name="applicationId" value={applicationId} />
          <button
            className="btn btn--secondary"
            type="submit"
            disabled={mailPending || !canResend}
          >
            {mailPending ? "送信中…" : "参加確定メールを再送する"}
          </button>
        </form>

        {canResend ? null : (
          <p className="form-field__note">
            受付番号が未発行のため送信できません（支払済みになると発行されます）。
          </p>
        )}
      </section>
    </>
  );
}
