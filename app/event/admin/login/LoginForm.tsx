"use client";

import { useActionState } from "react";

import { login, type LoginState } from "../actions";

const initialState: LoginState = { error: "" };

export function LoginForm() {
  const [state, formAction, pending] = useActionState(login, initialState);

  return (
    <form className="admin-login__form" action={formAction}>
      {state.error ? (
        <p className="apply-form__alert" role="alert">
          {state.error}
        </p>
      ) : null}

      <div className="form-field">
        <label className="form-field__label" htmlFor="admin-email">
          メールアドレス
        </label>
        <input
          className="form-field__input"
          id="admin-email"
          name="email"
          type="email"
          autoComplete="username"
          required
        />
      </div>

      <div className="form-field">
        <label className="form-field__label" htmlFor="admin-password">
          パスワード
        </label>
        <input
          className="form-field__input"
          id="admin-password"
          name="password"
          type="password"
          autoComplete="current-password"
          required
        />
      </div>

      <button className="btn btn--primary" type="submit" disabled={pending}>
        {pending ? "確認中…" : "ログイン"}
      </button>
    </form>
  );
}
