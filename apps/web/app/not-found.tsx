import Link from "next/link";
import { copy } from "@rooq/ui";
import { PublicPage } from "@/components/public/public-chrome";
import { StateBlock } from "@/components/primitives";

export default function NotFound() {
  return (
    <PublicPage>
      <div className="container" style={{ paddingTop: 48 }}>
        <StateBlock
          kind="empty"
          title="This page doesn't exist"
          body="Check the address, or go back to the markets."
          actions={
            <>
              <Link href="/app/markets" className="btn btn-primary">
                {copy.portfolio.openMarket}
              </Link>
              <Link href="/" className="btn">
                Rooq home
              </Link>
            </>
          }
        />
      </div>
    </PublicPage>
  );
}
