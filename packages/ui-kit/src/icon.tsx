/**
 * Icons.
 *
 * Original line icons drawn on a 16x16 grid with a 1.5px stroke, so they sit on
 * the same optical weight as the type. Not copied from any icon set.
 *
 * `stroke="currentColor"` everywhere means an icon inherits its colour from its
 * container, which is what lets a menu row change colour on hover without the
 * icon needing to know about states.
 */

import type { SVGProps } from 'react';

export type IconName =
  | 'chevronRight'
  | 'chevronLeft'
  | 'minus'
  | 'chevronDown'
  | 'dots'
  | 'plus'
  | 'search'
  | 'home'
  | 'star'
  | 'starFilled'
  | 'trash'
  | 'inbox'
  | 'lock'
  | 'unlock'
  | 'settings'
  | 'template'
  | 'import'
  | 'page'
  | 'text'
  | 'heading1'
  | 'heading2'
  | 'heading3'
  | 'bulletedList'
  | 'numberedList'
  | 'todo'
  | 'toggle'
  | 'quote'
  | 'divider'
  | 'code'
  | 'image'
  | 'video'
  | 'audio'
  | 'file'
  | 'bookmark'
  | 'equation'
  | 'embed'
  | 'database'
  | 'link'
  | 'mention'
  | 'date'
  | 'emoji'
  | 'sparkle'
  | 'toc'
  | 'breadcrumb'
  | 'duplicate'
  | 'moveTo'
  | 'delete'
  | 'undo'
  | 'redo'
  | 'help'
  | 'close';

const PATHS: Record<IconName, string> = {
  chevronRight: 'M6 3.5 10.5 8 6 12.5',
  chevronLeft: 'M10 3.5 5.5 8 10 12.5',
  minus: 'M3.5 8h9',
  chevronDown: 'M3.5 6 8 10.5 12.5 6',
  dots: 'M3.5 8h.01M8 8h.01M12.5 8h.01',
  plus: 'M8 3.5v9M3.5 8h9',
  search: 'M7 11.5a4.5 4.5 0 1 0 0-9 4.5 4.5 0 0 0 0 9ZM10.5 10.5 14 14',
  home: 'M2.5 7.5 8 2.5l5.5 5M4 6.5v6.5h8V6.5',
  star: 'm8 2.5 1.8 3.7 4 .6-2.9 2.8.7 4-3.6-1.9-3.6 1.9.7-4L2.2 6.8l4-.6z',
  starFilled: 'm8 2.5 1.8 3.7 4 .6-2.9 2.8.7 4-3.6-1.9-3.6 1.9.7-4L2.2 6.8l4-.6z',
  trash: 'M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8.2h5.8l.6-8.2M6.8 7v3.4M9.2 7v3.4',
  inbox: 'M2.5 9.5 4 4h8l1.5 5.5M2.5 9.5H6l.8 1.5h2.4l.8-1.5h3.5',
  lock: 'M5 7V5.5a3 3 0 0 1 6 0V7M4 7.5h8v6H4z',
  unlock: 'M5 7V5.5a3 3 0 0 1 5.6-1.4M4 7.5h8v6H4z',
  settings:
    'M8 10a2 2 0 1 0 0-4 2 2 0 0 0 0 4ZM8 1.8v1.6M8 12.6v1.6M14.2 8h-1.6M3.4 8H1.8M12.4 3.6l-1.1 1.1M4.7 11.3l-1.1 1.1M12.4 12.4l-1.1-1.1M4.7 4.7 3.6 3.6',
  template: 'M3 3.5h10v9H3zM3 6.5h10M6 6.5v6',
  import: 'M8 2.5v7M5 6.5 8 9.5l3-3M3 11v1.5h10V11',
  page: 'M4 2.5h5L12 5.5v8H4zM9 2.5v3h3',
  text: 'M3 4h10M8 4v9',
  heading1: 'M3 4v8M8 4v8M3 8h5M11 12V5.5L9.5 6.5',
  heading2: 'M3 4v8M8 4v8M3 8h5M10.5 5.2c0-.7.6-1.2 1.4-1.2.8 0 1.3.5 1.3 1.2 0 1.4-2.7 1.9-2.7 4.1h3',
  heading3: 'M3 4v8M8 4v8M3 8h5M10.5 5.4c.4-.3.9-.4 1.4-.4.8 0 1.3.4 1.3 1 0 .5-.3.9-.9 1 .7.1 1.1.5 1.1 1.1 0 .7-.6 1.1-1.5 1.1-.6 0-1.1-.2-1.5-.5',
  bulletedList: 'M6 4h7M6 8h7M6 12h7M3 4h.01M3 8h.01M3 12h.01',
  numberedList: 'M2.5 3.5h1V6M2.4 9.5c0-.6.5-1 1.1-1 .5 0 .9.3.9.8 0 1-2 1.3-2 2.7h2.2M6 4h7M6 8h7M6 12h7',
  todo: 'M2.5 4 4 5.5 6.5 3M9 4h4.5M2.5 11 4 12.5 6.5 10M9 11h4.5',
  toggle: 'M5 4.5 8 7l3-2.5M3.5 8h9M3.5 8v3.5h9V8',
  quote: 'M4 10.5V8l2-3M9 10.5V8l2-3M2.5 12.5h4M7.5 12.5h4',
  divider: 'M2 8h12',
  code: 'M5.5 5 3 8l2.5 3M10.5 5 13 8l-2.5 3',
  image: 'M2.5 3.5h11v9h-11zM2.5 10.5 6 7.5l3 2.5 2-1.5 2.5 2M5.5 6.2h.01',
  video: 'M2.5 4.5h7v7h-7zM9.5 8l4-2.5v5L9.5 8',
  audio: 'M5.5 11.5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3ZM7 3v7.5M7 3l5-1v7',
  file: 'M4 2.5h5L12 5.5v8H4zM9 2.5v3h3M6 8.5h4M6 11h4',
  bookmark: 'M4 2.5h8v11l-4-3-4 3z',
  equation: 'M4 12V4l3 4-3 4M9 5.5h4M9 10.5h4',
  embed: 'M3 4.5h10v7H3zM6 8h4',
  database: 'M8 2.5c2.5 0 4.5.7 4.5 1.5v8c0 .8-2 1.5-4.5 1.5s-4.5-.7-4.5-1.5V4c0-.8 2-1.5 4.5-1.5ZM3.5 4c0 .8 2 1.5 4.5 1.5S12.5 4.8 12.5 4M3.5 8c0 .8 2 1.5 4.5 1.5s4.5-.7 4.5-1.5',
  link: 'M6.5 9.5 9.5 6.5M6 4.5 7.5 3a2.8 2.8 0 0 1 4 4L10 8.5M10 11.5 8.5 13a2.8 2.8 0 0 1-4-4L6 7.5',
  mention: 'M11 8a3 3 0 1 1-6 0 3 3 0 0 1 6 0ZM14 8v1.5M11 12.5h1.5M11 9.5V8a1 1 0 0 0-2 0',
  date: 'M2.5 4.5h11v9h-11zM2.5 7.5h11M5.5 2.5v2.5M10.5 2.5v2.5',
  // A four-pointed star, drawn here rather than borrowed from a glyph set.
  // Two lenses meeting at the centre: one narrow and tall, one wide and flat.
  sparkle: 'M8 1.6c.3 3.3 1.9 4.9 5.2 5.2-3.3.3-4.9 1.9-5.2 5.2-.3-3.3-1.9-4.9-5.2-5.2 3.3-.3 4.9-1.9 5.2-5.2Z',
  emoji: 'M8 13a5 5 0 1 0 0-10 5 5 0 0 0 0 10ZM6 6.5h.01M10 6.5h.01M5.8 9.2a2.8 2.8 0 0 0 4.4 0',
  toc: 'M3 4h10M3 8h10M3 12h6M2 4h.01M2 8h.01M2 12h.01',
  breadcrumb: 'M6.5 4 3 8l3.5 4M9.5 4 13 8l-3.5 4',
  duplicate: 'M5.5 5.5h8v8h-8zM10.5 5.5v-3h-8v8h3',
  moveTo: 'M2.5 8h8M8 5l3 3-3 3M11.5 4.5v7',
  delete: 'M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8.2h5.8l.6-8.2M6.8 7v3.4M9.2 7v3.4',
  undo: 'M3 8h7a3 3 0 0 1 0 6H7M3 8l3-3M3 8l3 3',
  redo: 'M13 8H6a3 3 0 0 0 0 6h3M13 8l-3-3M13 8l-3 3',
  help: 'M8 13a5 5 0 1 0 0-10 5 5 0 0 0 0 10ZM6.3 6.3a1.8 1.8 0 1 1 2.4 1.7c-.5.2-.7.5-.7 1M8 11.2h.01',
  close: 'M4 4l8 8M12 4l-8 8',
};

/** Icons that read better filled than stroked, given a solid fill. */
const FILLED: ReadonlySet<IconName> = new Set<IconName>(['starFilled']);

export interface IconProps extends Omit<SVGProps<SVGSVGElement>, 'name'> {
  name: IconName;
  size?: number;
}

export function Icon({ name, size = 16, ...rest }: IconProps) {
  const filled = FILLED.has(name);
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill={filled ? 'currentColor' : 'none'}
      stroke={filled ? 'none' : 'currentColor'}
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...rest}
    >
      <path d={PATHS[name]} />
    </svg>
  );
}