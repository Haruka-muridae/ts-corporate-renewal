"use client";

import { useActionState, useId, useState } from "react";

import {
  AGE_GROUP_LABELS,
  INDUSTRY_LABELS,
  OCCUPATION_LABELS,
  POSITION_LABELS,
} from "@/lib/event/pricing.mjs";

import { submitApplication, type ApplyFormState } from "./actions";

/*
 * 選択肢の並び。
 * pricing.mjs のキー順ではなく、画面で選びやすい順に並べる
 * （割引額の大きい順に見えると意図が透けるため、業種のまとまりで並べる）。
 */
const INDUSTRY_ORDER = [
  "it",
  "finance",
  "life_insurance",
  "real_estate",
  "real_estate_investment",
  "hr",
  "recruitment_agency",
  "education",
  "medical",
  "construction",
  "manufacturing",
  "retail",
  "service",
  "professional",
  "other",
] as const;

const OCCUPATION_ORDER = [
  "sales",
  "marketing",
  "hr",
  "corporate_planning",
  "engineer",
  "designer",
  "consultant",
  "educator",
  "medical",
  "professional",
  "other",
] as const;

const POSITION_ORDER = [
  "executive",
  "representative",
  "officer",
  "manager",
  "employee",
  "sole_proprietor",
  "freelance",
  "student",
  "other",
] as const;

const AGE_GROUP_ORDER = ["18-23", "24+"] as const;

const initialState: ApplyFormState = { errors: {}, values: {} };

function FieldError({ id, message }: { id: string; message?: string }) {
  if (!message) {
    return null;
  }

  return (
    <p className="form-field__error" id={id} role="alert">
      {message}
    </p>
  );
}

export function ApplyForm() {
  const [state, formAction, pending] = useActionState(
    submitApplication,
    initialState,
  );

  const formId = useId();
  const { errors, values } = state;

  /*
   * 「その他」を選んだときだけ自由記述欄を出す（仕様書4.2）。
   * 送信結果で戻ってきた値も初期値として反映する。
   */
  const [industry, setIndustry] = useState(values.industry ?? "");
  const [occupation, setOccupation] = useState(values.occupation ?? "");

  const fieldId = (name: string) => `${formId}-${name}`;
  const errorId = (name: string) => `${formId}-${name}-error`;

  const describedBy = (name: string) =>
    errors[name] ? errorId(name) : undefined;

  return (
    <form className="apply-form" action={formAction} noValidate>
      {errors.form ? (
        <p className="apply-form__alert" role="alert">
          {errors.form}
        </p>
      ) : null}

      <fieldset className="form-group">
        <legend className="form-group__legend">基本情報</legend>

        <div className="form-field">
          <label className="form-field__label" htmlFor={fieldId("name")}>
            氏名<span className="form-field__required">必須</span>
          </label>
          <input
            className="form-field__input"
            id={fieldId("name")}
            name="name"
            type="text"
            autoComplete="name"
            defaultValue={values.name ?? ""}
            aria-invalid={errors.name ? true : undefined}
            aria-describedby={describedBy("name")}
            required
          />
          <FieldError id={errorId("name")} message={errors.name} />
        </div>

        <div className="form-field">
          <label className="form-field__label" htmlFor={fieldId("nameKana")}>
            氏名フリガナ<span className="form-field__required">必須</span>
          </label>
          <input
            className="form-field__input"
            id={fieldId("nameKana")}
            name="nameKana"
            type="text"
            defaultValue={values.nameKana ?? ""}
            aria-invalid={errors.nameKana ? true : undefined}
            aria-describedby={describedBy("nameKana")}
            required
          />
          <p className="form-field__note">
            ひらがな・カタカナのどちらでも入力できます。
          </p>
          <FieldError id={errorId("nameKana")} message={errors.nameKana} />
        </div>

        <div className="form-field">
          <label className="form-field__label" htmlFor={fieldId("email")}>
            メールアドレス<span className="form-field__required">必須</span>
          </label>
          <input
            className="form-field__input"
            id={fieldId("email")}
            name="email"
            type="email"
            autoComplete="email"
            inputMode="email"
            defaultValue={values.email ?? ""}
            aria-invalid={errors.email ? true : undefined}
            aria-describedby={describedBy("email")}
            required
          />
          <p className="form-field__note">
            参加確定メールと領収書をお送りします。
          </p>
          <FieldError id={errorId("email")} message={errors.email} />
        </div>

        <div className="form-field">
          <label className="form-field__label" htmlFor={fieldId("phone")}>
            電話番号<span className="form-field__required">必須</span>
          </label>
          <input
            className="form-field__input"
            id={fieldId("phone")}
            name="phone"
            type="tel"
            autoComplete="tel"
            inputMode="tel"
            defaultValue={values.phone ?? ""}
            aria-invalid={errors.phone ? true : undefined}
            aria-describedby={describedBy("phone")}
            required
          />
          <FieldError id={errorId("phone")} message={errors.phone} />
        </div>

        <div className="form-field">
          <label className="form-field__label" htmlFor={fieldId("company")}>
            会社名または団体名<span className="form-field__required">必須</span>
          </label>
          <input
            className="form-field__input"
            id={fieldId("company")}
            name="company"
            type="text"
            autoComplete="organization"
            defaultValue={values.company ?? ""}
            aria-invalid={errors.company ? true : undefined}
            aria-describedby={describedBy("company")}
            required
          />
          <FieldError id={errorId("company")} message={errors.company} />
        </div>

        <div className="form-field">
          <label className="form-field__label" htmlFor={fieldId("department")}>
            部署名<span className="form-field__optional">任意</span>
          </label>
          <input
            className="form-field__input"
            id={fieldId("department")}
            name="department"
            type="text"
            defaultValue={values.department ?? ""}
            aria-describedby={describedBy("department")}
          />
          <FieldError id={errorId("department")} message={errors.department} />
        </div>

        <div className="form-field">
          <label className="form-field__label" htmlFor={fieldId("jobTitle")}>
            役職名<span className="form-field__optional">任意</span>
          </label>
          <input
            className="form-field__input"
            id={fieldId("jobTitle")}
            name="jobTitle"
            type="text"
            autoComplete="organization-title"
            defaultValue={values.jobTitle ?? ""}
            aria-describedby={describedBy("jobTitle")}
          />
          <FieldError id={errorId("jobTitle")} message={errors.jobTitle} />
        </div>
      </fieldset>

      <fieldset className="form-group">
        <legend className="form-group__legend">ご所属について</legend>
        <p className="form-group__lead">
          ご入力内容に応じて参加費が決まります。次の画面で金額をご確認いただけます。
        </p>

        <div className="form-field">
          <label className="form-field__label" htmlFor={fieldId("industry")}>
            業界<span className="form-field__required">必須</span>
          </label>
          <select
            className="form-field__select"
            id={fieldId("industry")}
            name="industry"
            value={industry}
            onChange={(event) => setIndustry(event.target.value)}
            aria-invalid={errors.industry ? true : undefined}
            aria-describedby={describedBy("industry")}
            required
          >
            <option value="">選択してください</option>
            {INDUSTRY_ORDER.map((key) => (
              <option key={key} value={key}>
                {INDUSTRY_LABELS[key]}
              </option>
            ))}
          </select>
          <FieldError id={errorId("industry")} message={errors.industry} />
        </div>

        {industry === "other" ? (
          <div className="form-field">
            <label
              className="form-field__label"
              htmlFor={fieldId("industryOtherText")}
            >
              業界（その他の内容）
              <span className="form-field__required">必須</span>
            </label>
            <input
              className="form-field__input"
              id={fieldId("industryOtherText")}
              name="industryOtherText"
              type="text"
              defaultValue={values.industryOtherText ?? ""}
              aria-invalid={errors.industryOtherText ? true : undefined}
              aria-describedby={describedBy("industryOtherText")}
              required
            />
            <FieldError
              id={errorId("industryOtherText")}
              message={errors.industryOtherText}
            />
          </div>
        ) : null}

        <div className="form-field">
          <label className="form-field__label" htmlFor={fieldId("occupation")}>
            職種<span className="form-field__required">必須</span>
          </label>
          <select
            className="form-field__select"
            id={fieldId("occupation")}
            name="occupation"
            value={occupation}
            onChange={(event) => setOccupation(event.target.value)}
            aria-invalid={errors.occupation ? true : undefined}
            aria-describedby={describedBy("occupation")}
            required
          >
            <option value="">選択してください</option>
            {OCCUPATION_ORDER.map((key) => (
              <option key={key} value={key}>
                {OCCUPATION_LABELS[key]}
              </option>
            ))}
          </select>
          <FieldError id={errorId("occupation")} message={errors.occupation} />
        </div>

        {occupation === "other" ? (
          <div className="form-field">
            <label
              className="form-field__label"
              htmlFor={fieldId("occupationOtherText")}
            >
              職種（その他の内容）
              <span className="form-field__required">必須</span>
            </label>
            <input
              className="form-field__input"
              id={fieldId("occupationOtherText")}
              name="occupationOtherText"
              type="text"
              defaultValue={values.occupationOtherText ?? ""}
              aria-invalid={errors.occupationOtherText ? true : undefined}
              aria-describedby={describedBy("occupationOtherText")}
              required
            />
            <FieldError
              id={errorId("occupationOtherText")}
              message={errors.occupationOtherText}
            />
          </div>
        ) : null}

        <div className="form-field">
          <label className="form-field__label" htmlFor={fieldId("position")}>
            立場<span className="form-field__required">必須</span>
          </label>
          <select
            className="form-field__select"
            id={fieldId("position")}
            name="position"
            defaultValue={values.position ?? ""}
            aria-invalid={errors.position ? true : undefined}
            aria-describedby={describedBy("position")}
            required
          >
            <option value="">選択してください</option>
            {POSITION_ORDER.map((key) => (
              <option key={key} value={key}>
                {POSITION_LABELS[key]}
              </option>
            ))}
          </select>
          <FieldError id={errorId("position")} message={errors.position} />
        </div>

        <fieldset className="form-field form-choice">
          <legend className="form-field__label">
            年齢区分<span className="form-field__required">必須</span>
          </legend>
          {AGE_GROUP_ORDER.map((key) => (
            <label className="form-choice__item" key={key}>
              <input
                type="radio"
                name="ageGroup"
                value={key}
                defaultChecked={values.ageGroup === key}
                required
              />
              <span>{AGE_GROUP_LABELS[key]}</span>
            </label>
          ))}
          <FieldError id={errorId("ageGroup")} message={errors.ageGroup} />
        </fieldset>

        <fieldset className="form-field form-choice">
          <legend className="form-field__label">
            過去に主催者から出入り禁止・参加をお断りする通告を受けたことがありますか？
            <span className="form-field__required">必須</span>
          </legend>
          <label className="form-choice__item">
            <input
              type="radio"
              name="isBannedDeclared"
              value="no"
              defaultChecked={values.isBannedDeclared === "no"}
              required
            />
            <span>該当しない</span>
          </label>
          <label className="form-choice__item">
            <input
              type="radio"
              name="isBannedDeclared"
              value="yes"
              defaultChecked={values.isBannedDeclared === "yes"}
              required
            />
            <span>該当する</span>
          </label>
          <FieldError
            id={errorId("isBannedDeclared")}
            message={errors.isBannedDeclared}
          />
        </fieldset>
      </fieldset>

      <fieldset className="form-group">
        <legend className="form-group__legend">ご確認とご同意</legend>

        <div className="form-field form-consent">
          <label className="form-consent__item">
            <input
              type="checkbox"
              name="agreeTerms"
              aria-invalid={errors.agreeTerms ? true : undefined}
            />
            <span>
              <a href="/legal/terms/" target="_blank" rel="noreferrer">
                利用規約
              </a>
              に同意します
            </span>
          </label>
          <FieldError id={errorId("agreeTerms")} message={errors.agreeTerms} />

          <label className="form-consent__item">
            <input
              type="checkbox"
              name="agreeCancelPolicy"
              aria-invalid={errors.agreeCancelPolicy ? true : undefined}
            />
            <span>
              参加者ご都合によるキャンセル・返金を一切お受けしていないことに同意します（
              <a href="/event/#policy-title" target="_blank" rel="noreferrer">
                キャンセルポリシー
              </a>
              ）
            </span>
          </label>
          <FieldError
            id={errorId("agreeCancelPolicy")}
            message={errors.agreeCancelPolicy}
          />

          <label className="form-consent__item">
            <input
              type="checkbox"
              name="agreePrivacy"
              aria-invalid={errors.agreePrivacy ? true : undefined}
            />
            <span>
              氏名・会社名・業界・職種・立場が当日の名札に記載され、他の参加者に表示されることに同意します（
              <a href="/legal/privacy/" target="_blank" rel="noreferrer">
                個人情報の取り扱い
              </a>
              ）
            </span>
          </label>
          <FieldError
            id={errorId("agreePrivacy")}
            message={errors.agreePrivacy}
          />
        </div>
      </fieldset>

      <div className="apply-form__actions">
        <button className="btn btn--primary" type="submit" disabled={pending}>
          {pending ? "送信中…" : "確認画面へ進む"}
        </button>
        <p className="apply-form__note">
          この時点では決済は行われません。次の画面で金額をご確認いただけます。
        </p>
      </div>
    </form>
  );
}
