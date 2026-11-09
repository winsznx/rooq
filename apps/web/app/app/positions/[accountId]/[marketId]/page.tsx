import { redirect } from "next/navigation";

/** Public per-account position pages are gone. Your positions live in Portfolio, decrypted on this device. */
export default function Page() {
  redirect("/app/portfolio");
}
