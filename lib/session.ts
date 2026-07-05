import { cookies } from "next/headers";

export type Session =
  | { role: "owner" }
  | { role: "tester" }
  | { role: "employee"; employeeId: string }
  | { role: "none" };

export async function getSession(): Promise<Session> {
  const cookieStore = await cookies();
  const value = cookieStore.get("sft_session")?.value ?? "";
  if (value === "authenticated") return { role: "owner" };
  if (value === "tester") return { role: "tester" };
  if (value.startsWith("employee:")) return { role: "employee", employeeId: value.slice("employee:".length) };
  return { role: "none" };
}
