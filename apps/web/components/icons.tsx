import type { SVGProps } from "react";

/** One utility icon family: 20px grid, 1.75px stroke, round caps. Icons are never brand marks. */
type IconProps = Omit<SVGProps<SVGSVGElement>, "children"> & { size?: number; title?: string };

function Icon({ size = 20, title, children, ...rest }: IconProps & { children: React.ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden={title ? undefined : true}
      role={title ? "img" : undefined}
      {...rest}
    >
      {title ? <title>{title}</title> : null}
      {children}
    </svg>
  );
}

export const ChevronDown = (p: IconProps) => (
  <Icon {...p}>
    <path d="M5.5 8l4.5 4.5L14.5 8" />
  </Icon>
);
export const ChevronRight = (p: IconProps) => (
  <Icon {...p}>
    <path d="M8 5.5l4.5 4.5L8 14.5" />
  </Icon>
);
export const ChevronLeft = (p: IconProps) => (
  <Icon {...p}>
    <path d="M12 5.5L7.5 10l4.5 4.5" />
  </Icon>
);
export const Close = (p: IconProps) => (
  <Icon {...p}>
    <path d="M5.5 5.5l9 9M14.5 5.5l-9 9" />
  </Icon>
);
export const Search = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="8.75" cy="8.75" r="5.25" />
    <path d="M12.75 12.75L16 16" />
  </Icon>
);
export const Copy = (p: IconProps) => (
  <Icon {...p}>
    <rect x="7" y="7" width="9" height="9" rx="1.5" />
    <path d="M4 12.5V5.5A1.5 1.5 0 0 1 5.5 4h7" />
  </Icon>
);
export const External = (p: IconProps) => (
  <Icon {...p}>
    <path d="M11.5 4H16v4.5M16 4l-7 7" />
    <path d="M14 11.5V15a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h3.5" />
  </Icon>
);
export const Info = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="10" cy="10" r="7" />
    <path d="M10 9v4.5M10 6.5v.01" />
  </Icon>
);
export const Check = (p: IconProps) => (
  <Icon {...p}>
    <path d="M4.5 10.5l3.5 3.5 7.5-8" />
  </Icon>
);
export const Warning = (p: IconProps) => (
  <Icon {...p}>
    <path d="M10 3.5L17 16H3l7-12.5z" />
    <path d="M10 8.5v3.5M10 14v.01" />
  </Icon>
);
export const Blocked = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="10" cy="10" r="7" />
    <path d="M5.2 14.8l9.6-9.6" />
  </Icon>
);
export const Wallet = (p: IconProps) => (
  <Icon {...p}>
    <path d="M3.5 6.5A1.5 1.5 0 0 1 5 5h10.5v10H5a1.5 1.5 0 0 1-1.5-1.5v-7z" />
    <path d="M12.5 10h3" />
  </Icon>
);
export const SwapArrows = (p: IconProps) => (
  <Icon {...p}>
    <path d="M6 3.5v12M3 12.5l3 3 3-3M14 16.5v-12M17 7.5l-3-3-3 3" />
  </Icon>
);
export const Menu = (p: IconProps) => (
  <Icon {...p}>
    <path d="M3.5 6h13M3.5 10h13M3.5 14h13" />
  </Icon>
);
export const Sun = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="10" cy="10" r="3.25" />
    <path d="M10 2.5v1.5M10 16v1.5M2.5 10H4M16 10h1.5M4.7 4.7l1 1M14.3 14.3l1 1M4.7 15.3l1-1M14.3 5.7l1-1" />
  </Icon>
);
export const Moon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M15.5 12.2A6.5 6.5 0 0 1 7.8 4.5a6.5 6.5 0 1 0 7.7 7.7z" />
  </Icon>
);
export const Monitor = (p: IconProps) => (
  <Icon {...p}>
    <rect x="3" y="4" width="14" height="9.5" rx="1.25" />
    <path d="M7.5 16.5h5M10 13.5v3" />
  </Icon>
);
export const Plus = (p: IconProps) => (
  <Icon {...p}>
    <path d="M10 4.5v11M4.5 10h11" />
  </Icon>
);
export const Minus = (p: IconProps) => (
  <Icon {...p}>
    <path d="M4.5 10h11" />
  </Icon>
);
export const Markets = (p: IconProps) => (
  <Icon {...p}>
    <path d="M3.5 5h13M3.5 10h13M3.5 15h13" />
    <path d="M7 3.5v3M12.5 8.5v3M9 13.5v3" />
  </Icon>
);
export const Trade = (p: IconProps) => (
  <Icon {...p}>
    <path d="M3.5 14.5l4-4.5 3 3 6-7" />
    <path d="M12.5 6h4v4" />
  </Icon>
);
export const Portfolio = (p: IconProps) => (
  <Icon {...p}>
    <rect x="3" y="6" width="14" height="10" rx="1.5" />
    <path d="M7.5 6V4.5h5V6M3 10.5h14" />
  </Icon>
);
export const Liquidity = (p: IconProps) => (
  <Icon {...p}>
    <path d="M10 3.5c3 3.5 4.5 6 4.5 8a4.5 4.5 0 0 1-9 0c0-2 1.5-4.5 4.5-8z" />
  </Icon>
);
export const Create = (p: IconProps) => (
  <Icon {...p}>
    <rect x="3.5" y="3.5" width="13" height="13" rx="1.5" />
    <path d="M10 7v6M7 10h6" />
  </Icon>
);
export const Activity = (p: IconProps) => (
  <Icon {...p}>
    <path d="M3 10h3l2-5 4 10 2-5h3" />
  </Icon>
);
export const Maker = (p: IconProps) => (
  <Icon {...p}>
    <path d="M4 16.5V9M10 16.5V4M16 16.5v-5" />
    <path d="M2.5 16.5h15" />
  </Icon>
);
export const Settings = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="10" cy="10" r="2.5" />
    <path d="M10 2.75v2M10 15.25v2M2.75 10h2M15.25 10h2M4.9 4.9l1.4 1.4M13.7 13.7l1.4 1.4M4.9 15.1l1.4-1.4M13.7 6.3l1.4-1.4" />
  </Icon>
);
export const Docs = (p: IconProps) => (
  <Icon {...p}>
    <path d="M5.5 3h6.5l3.5 3.5V17h-10V3z" />
    <path d="M12 3v3.5h3.5M8 10.5h5M8 13.5h5" />
  </Icon>
);
export const Pulse = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="10" cy="10" r="2" />
    <path d="M5.5 5.5a6.4 6.4 0 0 0 0 9M14.5 5.5a6.4 6.4 0 0 1 0 9" />
  </Icon>
);
export const More = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="5" cy="10" r="1" />
    <circle cx="10" cy="10" r="1" />
    <circle cx="15" cy="10" r="1" />
  </Icon>
);
export const Star = ({ filled, ...p }: IconProps & { filled?: boolean }) => (
  <Icon {...p} fill={filled ? "currentColor" : "none"}>
    <path d="M10 3.2l2.05 4.3 4.7.62-3.43 3.27.87 4.67L10 13.78l-4.19 2.28.87-4.67L3.25 8.12l4.7-.62L10 3.2z" />
  </Icon>
);
export const Overview = (p: IconProps) => (
  <Icon {...p}>
    <path d="M3.5 16.5h13M3.5 12.5h6M3.5 8.5h13M3.5 4.5h9" />
  </Icon>
);
export const Operations = (p: IconProps) => (
  <Icon {...p}>
    <path d="M4 5.5h12M4 10h8M4 14.5h5" />
    <path d="M13.5 13l2 2 3-3.5" />
  </Icon>
);
export const Eye = ({ off, ...p }: IconProps & { off?: boolean }) => (
  <Icon {...p}>
    <path d="M2.5 10s2.8-5 7.5-5 7.5 5 7.5 5-2.8 5-7.5 5-7.5-5-7.5-5z" />
    <circle cx="10" cy="10" r="2.25" />
    {off ? <path d="M4 16L16 4" /> : null}
  </Icon>
);
export const ArrowUp = (p: IconProps) => (
  <Icon {...p}>
    <path d="M10 15.5v-11M5.5 9L10 4.5 14.5 9" />
  </Icon>
);
export const ArrowDown = (p: IconProps) => (
  <Icon {...p}>
    <path d="M10 4.5v11M5.5 11L10 15.5 14.5 11" />
  </Icon>
);
