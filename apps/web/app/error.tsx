"use client";

import Link from "next/link";
import { copy } from "@rooq/ui";
import { PublicPage } from "@/components/public/public-chrome";
import { StateBlock } from "@/components/primitives";

export default function ErrorPage({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <PublicPage>
      <div className="container" style={{ paddingTop: 48 }}>
        <StateBlock
          kind="unavailable"
          title="Something went wrong"
          body={
            <>
              {copy.errors.generic}
              {error.digest ? <span className="num" style={{ display: "block", marginTop: 4 }}>{`Reference ${error.digest}`}</span> : null}
            </>
          }
          actions={
            <>
              <button type="button" className="btn btn-primary" onClick={reset}>
                {copy.activity.retry}
              </button>
              <Link href="/status" className="btn">
                {copy.system.status}
              </Link>
            </>
          }
        />
      </div>
    </PublicPage>
  );
}
