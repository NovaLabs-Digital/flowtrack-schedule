"use client";

import { createContext, useContext } from "react";
import { useDemoExperience } from "./useDemoExperience";

type DemoExperienceContextValue = ReturnType<typeof useDemoExperience>;

const DemoExperienceContext = createContext<DemoExperienceContextValue | null>(null);

export function DemoExperienceProvider({ children }: { children: React.ReactNode }) {
  const value = useDemoExperience();
  return (
    <DemoExperienceContext.Provider value={value}>
      {children}
    </DemoExperienceContext.Provider>
  );
}

export function useDemoExperienceContext() {
  const ctx = useContext(DemoExperienceContext);
  if (!ctx) {
    throw new Error("useDemoExperienceContext must be used within a DemoExperienceProvider");
  }
  return ctx;
}
