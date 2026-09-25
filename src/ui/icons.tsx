import type { SVGProps } from "react";

/**
 * Inline SVG icons. Unicode symbols depend on system fonts and some of them
 * render as boxes on Windows.
 */

type Props = SVGProps<SVGSVGElement> & { size?: number };

function Svg({ size = 16, children, ...rest }: Props) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...rest}
    >
      {children}
    </svg>
  );
}

export const IconHash = (p: Props) => (
  <Svg {...p}>
    <path d="M6 2.5 4.6 13.5M11.4 2.5 10 13.5M2.6 5.8h11M2.2 10.2h11" />
  </Svg>
);

export const IconSpeaker = (p: Props) => (
  <Svg {...p}>
    <path d="M8.5 3 5 5.8H2.8v4.4H5L8.5 13z" />
    <path d="M11 6.2a2.6 2.6 0 0 1 0 3.6M12.9 4.3a5.2 5.2 0 0 1 0 7.4" />
  </Svg>
);

export const IconMic = (p: Props) => (
  <Svg {...p}>
    <rect x="6" y="1.8" width="4" height="7.4" rx="2" />
    <path d="M3.6 7.4a4.4 4.4 0 0 0 8.8 0M8 11.8v2.4" />
  </Svg>
);

export const IconMicOff = (p: Props) => (
  <Svg {...p}>
    <rect x="6" y="1.8" width="4" height="7.4" rx="2" />
    <path d="M3.6 7.4a4.4 4.4 0 0 0 8.8 0M8 11.8v2.4M2.4 2.2l11.2 11.6" />
  </Svg>
);

export const IconHeadset = (p: Props) => (
  <Svg {...p}>
    <path d="M3 10.4V8a5 5 0 0 1 10 0v2.4" />
    <rect x="1.8" y="9.4" width="3" height="4.2" rx="1.2" />
    <rect x="11.2" y="9.4" width="3" height="4.2" rx="1.2" />
  </Svg>
);

export const IconHeadsetOff = (p: Props) => (
  <Svg {...p}>
    <path d="M3 10.4V8a5 5 0 0 1 10 0v2.4" />
    <rect x="1.8" y="9.4" width="3" height="4.2" rx="1.2" />
    <rect x="11.2" y="9.4" width="3" height="4.2" rx="1.2" />
    <path d="M2.4 2.2l11.2 11.6" />
  </Svg>
);

export const IconPlus = (p: Props) => (
  <Svg {...p}>
    <path d="M8 3.2v9.6M3.2 8h9.6" />
  </Svg>
);

/** Filled paper plane for the send button. */
export const IconSend = (p: Props) => (
  <Svg {...p} stroke="none">
    <path
      fill="currentColor"
      d="M2.1 2.2c-.5-.2-1 .3-.8.8L3 7.4l6.1.6-6.1.6-1.7 4.4c-.2.5.3 1 .8.8l12-5.3c.5-.2.5-.8 0-1z"
    />
  </Svg>
);

export const IconFile = (p: Props) => (
  <Svg {...p}>
    <path d="M9.2 1.8H4.4a1.2 1.2 0 0 0-1.2 1.2v10a1.2 1.2 0 0 0 1.2 1.2h7.2a1.2 1.2 0 0 0 1.2-1.2V5.4z" />
    <path d="M9.2 1.8v3.6h3.6" />
  </Svg>
);

export const IconPlay = (p: Props) => (
  <Svg {...p} stroke="none">
    <path fill="currentColor" d="M5 3.1c0-.6.7-1 1.2-.7l6.6 4.1c.5.3.5 1.1 0 1.4l-6.6 4.1c-.5.3-1.2-.1-1.2-.7z" />
  </Svg>
);

export const IconClip = (p: Props) => (
  <Svg {...p}>
    <path d="M12.6 7.4 7.5 12.5a3.2 3.2 0 0 1-4.5-4.5l5.6-5.6a2.1 2.1 0 1 1 3 3l-5.6 5.6a1 1 0 0 1-1.5-1.5l5.1-5.1" />
  </Svg>
);

export const IconUsers = (p: Props) => (
  <Svg {...p}>
    <circle cx="6" cy="5.4" r="2.4" />
    <path d="M1.8 13.4c0-2.3 1.9-3.8 4.2-3.8s4.2 1.5 4.2 3.8" />
    <path d="M10.8 3.4a2.4 2.4 0 0 1 0 4M11.8 9.9c1.4.4 2.4 1.5 2.4 3.5" />
  </Svg>
);

export const IconVideo = (p: Props) => (
  <Svg {...p}>
    <rect x="1.6" y="4" width="9" height="8" rx="1.8" />
    <path d="M10.6 8.4l3.8 2.4V5.2l-3.8 2.4z" />
  </Svg>
);

export const IconVideoOff = (p: Props) => (
  <Svg {...p}>
    <rect x="1.6" y="4" width="9" height="8" rx="1.8" />
    <path d="M10.6 8.4l3.8 2.4V5.2l-3.8 2.4z" />
    <path d="M2.4 2.2l11.2 11.6" />
  </Svg>
);

export const IconScreen = (p: Props) => (
  <Svg {...p}>
    <rect x="1.6" y="2.6" width="12.8" height="9" rx="1.6" />
    <path d="M5.6 14h4.8" />
  </Svg>
);

export const IconScreenOff = (p: Props) => (
  <Svg {...p}>
    <rect x="1.6" y="2.6" width="12.8" height="9" rx="1.6" />
    <path d="M5.6 14h4.8M2.4 2.2l11.2 11.6" />
  </Svg>
);

export const IconGear = (p: Props) => (
  <Svg {...p} strokeWidth={1.3}>
    <path d="M6.48 3.03 L6.80 1.20 L9.20 1.20 L9.52 3.03 L10.44 3.41 L11.96 2.35 L13.65 4.04 L12.59 5.56 L12.97 6.48 L14.80 6.80 L14.80 9.20 L12.97 9.52 L12.59 10.44 L13.65 11.96 L11.96 13.65 L10.44 12.59 L9.52 12.97 L9.20 14.80 L6.80 14.80 L6.48 12.97 L5.56 12.59 L4.04 13.65 L2.35 11.96 L3.41 10.44 L3.03 9.52 L1.20 9.20 L1.20 6.80 L3.03 6.48 L3.41 5.56 L2.35 4.04 L4.04 2.35 L5.56 3.41Z" />
    <circle cx="8" cy="8" r="2.2" />
  </Svg>
);

export const IconVolume = (p: Props) => (
  <Svg {...p}>
    <path d="M7.6 3.2 4.4 5.8H2.2v4.4h2.2l3.2 2.6z" />
    <path d="M10.4 6.4a2.4 2.4 0 0 1 0 3.2" />
  </Svg>
);

export const IconChat = (p: Props) => (
  <Svg {...p}>
    <path d="M13.8 9.6a1.8 1.8 0 0 1-1.8 1.8H5.4L2.2 14V3.8A1.8 1.8 0 0 1 4 2h8a1.8 1.8 0 0 1 1.8 1.8z" />
  </Svg>
);

export const IconCopy = (p: Props) => (
  <Svg {...p}>
    <rect x="5.4" y="5.4" width="8.2" height="8.2" rx="1.6" />
    <path d="M10.6 5.4V4a1.6 1.6 0 0 0-1.6-1.6H4A1.6 1.6 0 0 0 2.4 4v5a1.6 1.6 0 0 0 1.6 1.6h1.4" />
  </Svg>
);

export const IconUser = (p: Props) => (
  <Svg {...p}>
    <circle cx="8" cy="5.4" r="2.8" />
    <path d="M2.6 14c0-2.8 2.4-4.6 5.4-4.6s5.4 1.8 5.4 4.6" />
  </Svg>
);

export const IconExpand = (p: Props) => (
  <Svg {...p}>
    <path d="M9.6 2.4h4v4M6.4 13.6h-4v-4M13.6 2.4 9.2 6.8M2.4 13.6l4.4-4.4" />
  </Svg>
);

export const IconChevron = (p: Props) => (
  <Svg {...p}>
    <path d="M4.4 6.2 8 9.8l3.6-3.6" />
  </Svg>
);

export const IconHome = (p: Props) => (
  <Svg {...p}>
    <path d="M2.4 7.2 8 2.4l5.6 4.8" />
    <path d="M3.8 8.2v4.6a.9.9 0 0 0 .9.9h6.6a.9.9 0 0 0 .9-.9V8.2" />
  </Svg>
);

export const IconEdit = (p: Props) => (
  <Svg {...p}>
    <path d="M11.2 2.6 13.4 4.8 5.6 12.6 2.6 13.4l.8-3z" />
  </Svg>
);

export const IconTrash = (p: Props) => (
  <Svg {...p}>
    <path d="M2.8 4.4h10.4M6.4 4.4V2.8h3.2v1.6M4.4 4.4l.6 8.2a1 1 0 0 0 1 .9h4a1 1 0 0 0 1-.9l.6-8.2" />
  </Svg>
);

export const IconReply = (p: Props) => (
  <Svg {...p}>
    <path d="M6.4 3.4 2.6 7l3.8 3.6" />
    <path d="M2.8 7h6.4a4 4 0 0 1 4 4v1.6" />
  </Svg>
);

export const IconFullscreen = (p: Props) => (
  <Svg {...p}>
    <path d="M2.6 6V2.6h3.4M13.4 6V2.6H10M2.6 10v3.4H6M13.4 10v3.4H10" />
  </Svg>
);

export const IconPopout = (p: Props) => (
  <Svg {...p}>
    <path d="M7.4 3.2H3.4a1 1 0 0 0-1 1v8.2a1 1 0 0 0 1 1h8.2a1 1 0 0 0 1-1V8.6" />
    <path d="M9.6 2.6h3.8v3.8M13.2 2.8 7.8 8.2" />
  </Svg>
);

export const IconClose = (p: Props) => (
  <Svg {...p}>
    <path d="M3.6 3.6 12.4 12.4M12.4 3.6 3.6 12.4" />
  </Svg>
);

export const IconRefresh = (p: Props) => (
  <Svg {...p}>
    <path d="M13.2 8a5.2 5.2 0 1 1-1.6-3.7" />
    <path d="M13.4 2.6v3.2h-3.2" />
  </Svg>
);

export const IconDownload = (p: Props) => (
  <Svg {...p}>
    <path d="M8 2.6v7.2M5 7l3 3 3-3M2.8 12.4h10.4" />
  </Svg>
);

export const IconSearch = (p: Props) => (
  <Svg {...p}>
    <circle cx="7" cy="7" r="4.4" />
    <path d="M10.3 10.3 13.6 13.6" />
  </Svg>
);

export const IconSmile = (p: Props) => (
  <Svg {...p}>
    <circle cx="8" cy="8" r="5.8" />
    <path d="M5.6 9.4a2.8 2.8 0 0 0 4.8 0M6 6.4h.01M10 6.4h.01" />
  </Svg>
);

export const IconShield = (p: Props) => (
  <Svg {...p}>
    <path d="M8 1.8 13 3.6v4c0 3.2-2.2 5.4-5 6.6-2.8-1.2-5-3.4-5-6.6v-4z" />
  </Svg>
);

/** Handset for leaving a call. */
export const IconHangup = (p: Props) => (
  <Svg {...p}>
    <path d="M1.8 9.6c3.4-3.1 9-3.1 12.4 0l-1.4 1.9c-.2.3-.6.4-.9.2l-1.7-.9c-.3-.2-.5-.5-.4-.8l.2-1.2c-1.3-.5-2.7-.5-4 0l.2 1.2c.1.3-.1.6-.4.8l-1.7.9c-.3.2-.7.1-.9-.2z" />
  </Svg>
);

export const IconEye = (p: Props) => (
  <Svg {...p}>
    <path d="M1.4 8s2.4-4.6 6.6-4.6S14.6 8 14.6 8s-2.4 4.6-6.6 4.6S1.4 8 1.4 8z" />
    <circle cx="8" cy="8" r="2" />
  </Svg>
);

export const IconEyeOff = (p: Props) => (
  <Svg {...p}>
    <path d="M1.4 8s2.4-4.6 6.6-4.6S14.6 8 14.6 8s-2.4 4.6-6.6 4.6S1.4 8 1.4 8z" />
    <circle cx="8" cy="8" r="2" />
    <path d="M2.4 2.2l11.2 11.6" />
  </Svg>
);

export const IconPalette = (p: Props) => (
  <Svg {...p}>
    <path d="M8 1.8a6.2 6.2 0 1 0 0 12.4c.9 0 1.3-.6 1.1-1.3-.3-.9.1-1.9 1.2-1.9h1.3a2.6 2.6 0 0 0 2.6-2.6C14.2 4.9 11.4 1.8 8 1.8z" />
    <circle cx="5" cy="7" r=".9" fill="currentColor" stroke="none" />
    <circle cx="7.6" cy="4.6" r=".9" fill="currentColor" stroke="none" />
    <circle cx="10.6" cy="5.6" r=".9" fill="currentColor" stroke="none" />
  </Svg>
);

export const IconLogout = (p: Props) => (
  <Svg {...p}>
    <path d="M6.4 2.6H4a1.4 1.4 0 0 0-1.4 1.4v8A1.4 1.4 0 0 0 4 13.4h2.4" />
    <path d="M9.6 11 12.8 8 9.6 5M12.6 8H6.2" />
  </Svg>
);

/* window buttons: thin strokes on a 10 px grid, like the system ones */
const WinSvg = ({ size = 10, children, ...rest }: Props) => (
  <svg width={size} height={size} viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1" aria-hidden="true" {...rest}>
    {children}
  </svg>
);

export const IconWinMinimize = (p: Props) => (
  <WinSvg {...p}>
    <path d="M0 5.5h10" />
  </WinSvg>
);

export const IconWinMaximize = (p: Props) => (
  <WinSvg {...p}>
    <rect x="0.5" y="0.5" width="9" height="9" />
  </WinSvg>
);

export const IconWinRestore = (p: Props) => (
  <WinSvg {...p}>
    <rect x="0.5" y="2.5" width="7" height="7" />
    <path d="M2.5 2.5V.5h7v7h-2" />
  </WinSvg>
);

export const IconWinClose = (p: Props) => (
  <WinSvg {...p}>
    <path d="M0.5 0.5l9 9M9.5 0.5l-9 9" />
  </WinSvg>
);

export const IconVolumeOff = (p: Props) => (
  <Svg {...p}>
    <path d="M8.5 3 5 5.8H2.8v4.4H5L8.5 13z" />
    <path d="M11 6l3.2 4M14.2 6 11 10" />
  </Svg>
);

export const IconBell = (p: Props) => (
  <Svg {...p}>
    <path d="M4 11.2V7.4a4 4 0 0 1 8 0v3.8l1.2 1.3H2.8z" />
    <path d="M6.6 13.8a1.5 1.5 0 0 0 2.8 0" />
  </Svg>
);

export const IconBellOff = (p: Props) => (
  <Svg {...p}>
    <path d="M4 11.2V7.4a4 4 0 0 1 8 0v3.8l1.2 1.3H2.8z" />
    <path d="M6.6 13.8a1.5 1.5 0 0 0 2.8 0" />
    <path d="M2.4 2.2l11.2 11.6" />
  </Svg>
);

export const IconCheck = (p: Props) => (
  <Svg {...p}>
    <path d="M3 8.4 6.4 11.6 13 4.6" />
  </Svg>
);

export const IconDoorOut = (p: Props) => (
  <Svg {...p}>
    <path d="M9 2.6H3.6v10.8H9" />
    <path d="M7 8h7M11.6 5.4 14.2 8l-2.6 2.6" />
  </Svg>
);

export const IconSwap = (p: Props) => (
  <Svg {...p}>
    <path d="M2.6 5.4h10.2L10.4 3M13.4 10.6H3.2L5.6 13" />
  </Svg>
);

export const IconFormat = (p: Props) => (
  <Svg {...p}>
    <path d="M2 13 5.6 3.4h.8L10 13M3.3 9.6h5.4" />
    <path d="M11.2 9.4a1.9 1.9 0 1 1 0 3.6 1.9 1.9 0 0 1 0-3.6zM13.2 8.6V13" />
  </Svg>
);

export const IconBold = (p: Props) => (
  <Svg {...p} strokeWidth="2">
    <path d="M4.6 2.8h4a2.5 2.5 0 0 1 0 5h-4zM4.6 7.8h4.8a2.7 2.7 0 0 1 0 5.4H4.6z" />
  </Svg>
);

export const IconItalic = (p: Props) => (
  <Svg {...p}>
    <path d="M6.6 2.8h5M4.4 13.2h5M9.4 2.8 6.6 13.2" />
  </Svg>
);

export const IconUnderline = (p: Props) => (
  <Svg {...p}>
    <path d="M4.4 2.6v4.8a3.6 3.6 0 0 0 7.2 0V2.6M3.4 13.6h9.2" />
  </Svg>
);

export const IconStrike = (p: Props) => (
  <Svg {...p}>
    <path d="M11.2 4.4c-.4-1.1-1.6-1.8-3.2-1.8-1.9 0-3.2 1-3.2 2.3 0 .8.4 1.4 1.3 1.9M2.6 8h10.8M5 11.4c.4 1.2 1.6 2 3.3 2 2 0 3.3-1 3.3-2.4 0-.4-.1-.7-.3-1" />
  </Svg>
);

export const IconCode = (p: Props) => (
  <Svg {...p}>
    <path d="M5.4 4.4 1.8 8l3.6 3.6M10.6 4.4 14.2 8l-3.6 3.6" />
  </Svg>
);

export const IconCodeBlock = (p: Props) => (
  <Svg {...p}>
    <rect x="1.8" y="2.4" width="12.4" height="11.2" rx="2" />
    <path d="M6.2 6.2 4.4 8l1.8 1.8M9.8 6.2 11.6 8l-1.8 1.8" />
  </Svg>
);

export const IconQuote = (p: Props) => (
  <Svg {...p}>
    <path d="M3 3v10M6 4.6h7.4M6 8h7.4M6 11.4h5" />
  </Svg>
);

export const IconList = (p: Props) => (
  <Svg {...p}>
    <path d="M6 4h8M6 8h8M6 12h8" />
    <circle cx="2.8" cy="4" r=".8" fill="currentColor" stroke="none" />
    <circle cx="2.8" cy="8" r=".8" fill="currentColor" stroke="none" />
    <circle cx="2.8" cy="12" r=".8" fill="currentColor" stroke="none" />
  </Svg>
);

export const IconListNumbers = (p: Props) => (
  <Svg {...p}>
    <path d="M6.4 4h7.6M6.4 8h7.6M6.4 12h7.6" />
    <path d="M2 2.8h1v2.6M2 5.4h2M2 9.8c.2-.6.7-.8 1.1-.8.5 0 .9.3.9.8 0 .8-2 1.2-2 2.4h2" strokeWidth="1.1" />
  </Svg>
);

export const IconChecklist = (p: Props) => (
  <Svg {...p}>
    <rect x="1.8" y="2.4" width="4" height="4" rx="1" />
    <rect x="1.8" y="9.6" width="4" height="4" rx="1" />
    <path d="M2.8 4.4l.9.9 1.4-1.6M8 4.4h6M8 11.6h6" />
  </Svg>
);

export const IconLink = (p: Props) => (
  <Svg {...p}>
    <path d="M6.8 9.2a2.6 2.6 0 0 0 3.7 0l2.2-2.2a2.6 2.6 0 0 0-3.7-3.7l-.8.8" />
    <path d="M9.2 6.8a2.6 2.6 0 0 0-3.7 0L3.3 9a2.6 2.6 0 0 0 3.7 3.7l.8-.8" />
  </Svg>
);

export const IconSpoiler = (p: Props) => (
  <Svg {...p}>
    <rect x="1.6" y="4.4" width="12.8" height="7.2" rx="2" />
    <path d="M4.4 8h7.2" strokeDasharray="1.4 1.4" />
  </Svg>
);

export const IconHeading = (p: Props) => (
  <Svg {...p}>
    <path d="M3 3v10M10 3v10M3 8h7M12.4 7.4 14 6.6V13" />
  </Svg>
);

export const IconHelp = (p: Props) => (
  <Svg {...p}>
    <circle cx="8" cy="8" r="6.2" />
    <path d="M6.2 6.2a1.9 1.9 0 0 1 3.6.7c0 1.3-1.8 1.5-1.8 2.7" />
    <circle cx="8" cy="11.6" r=".7" fill="currentColor" stroke="none" />
  </Svg>
);

export const IconMarkRead = (p: Props) => (
  <Svg {...p}>
    <path d="M1.8 8.4 4.8 11.4 11 4.8M8.2 11.2l.4.3 6-6.6" />
  </Svg>
);
