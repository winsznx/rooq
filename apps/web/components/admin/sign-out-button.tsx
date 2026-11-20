"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/components/feedback/toast";

/**
 * The session cookie is HttpOnly, so only the server can clear it. Cached admin data is dropped from memory,
 * then the refresh re-runs the layout's session check, which now shows the sign-in view.
 */
export function SignOutButton(): React.JSX.Element {
  const { notify } = useToast();
  const router = useRouter();
  const queryClient = useQueryClient();
  const [working, setWorking] = useState(false);

  const signOut = async (): Promise<void> => {
    setWorking(true);
    try {
      const res = await fetch("/admin/api/auth/logout", { method: "POST", credentials: "same-origin", cache: "no-store" });
      if (!res.ok) throw new Error(`logout answered ${res.status}`);
      queryClient.removeQueries({ queryKey: ["admin"] });
      router.replace("/admin");
      router.refresh();
    } catch (error) {
      console.warn("admin sign-out failed", error);
      notify({ tone: "failure", title: "Sign-out didn't finish", body: "The session is still active. Try again." });
      setWorking(false);
    }
  };

  return (
    <button type="button" className="btn btn-sm" onClick={() => void signOut()} disabled={working} aria-busy={working}>
      Sign out
    </button>
  );
}
