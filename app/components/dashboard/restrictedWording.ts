"use client";

// The sentence shown next to a disabled change control. Every component
// keeps its own approved default (RESTRICTED_WORDING -- account/billing
// restriction wording) and reads it through useRestrictedWording, which
// returns that default unchanged unless a provider supplies different
// wording. Only a Guided Demo Session's watch mode provides one ("You're
// watching. The host can give you control."), so the normal app's wording
// is untouched.
import { createContext, createElement, useContext, type ReactNode } from "react";

const RestrictedWordingContext = createContext<string | null>(null);

export function RestrictedWordingProvider({ wording, children }: { wording: string | null; children?: ReactNode }) {
  return createElement(RestrictedWordingContext.Provider, { value: wording }, children);
}

export function useRestrictedWording(defaultWording: string): string {
  return useContext(RestrictedWordingContext) ?? defaultWording;
}
