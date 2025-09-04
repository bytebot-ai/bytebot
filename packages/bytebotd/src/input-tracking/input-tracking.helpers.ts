import { UiohookKey } from 'uiohook-napi';

export type KeyInfo = {
  name: string;
  isPrintable: boolean;
  string?: string;
  shiftString?: string;
};

export const keyInfoMap: Record<number, KeyInfo> = {
  [UiohookKey.Backspace]: {
    name: 'Backspace',
    isPrintable: false,
  },
  [UiohookKey.Tab]: {
    name: 'Tab',
    isPrintable: false,
  },
  [UiohookKey.Enter]: {
    name: 'Enter',
    isPrintable: false,
  },
  [UiohookKey.CapsLock]: {
    name: 'CapsLock',
    isPrintable: false,
  },
  [UiohookKey.Escape]: {
    name: 'Escape',
    isPrintable: false,
  },
  [UiohookKey.Space]: {
    name: 'Space',
    isPrintable: true,
    string: ' ',
    shiftString: ' ',
  },
  [UiohookKey.PageUp]: {
    name: 'PageUp',
    isPrintable: false,
  },
  [UiohookKey.PageDown]: {
    name: 'PageDown',
    isPrintable: false,
  },
  [UiohookKey.End]: {
    name: 'End',
    isPrintable: false,
  },
  [UiohookKey.Home]: {
    name: 'Home',
    isPrintable: false,
  },
  [UiohookKey.ArrowLeft]: {
    name: 'Left',
    isPrintable: false,
  },
  [UiohookKey.ArrowUp]: {
    name: 'Up',
    isPrintable: false,
  },
  [UiohookKey.ArrowRight]: {
    name: 'Right',
    isPrintable: false,
  },
  [UiohookKey.ArrowDown]: {
    name: 'Down',
    isPrintable: false,
  },
  [UiohookKey.Insert]: {
    name: 'Insert',
    isPrintable: false,
  },
  [UiohookKey.Delete]: {
    name: 'Delete',
    isPrintable: false,
  },

  [UiohookKey.Numpad0]: {
    name: 'Numpad0',
    isPrintable: true,
    string: '0',
    shiftString: '0',
  },
  [UiohookKey.Numpad1]: {
    name: 'Numpad1',
    isPrintable: true,
    string: '1',
    shiftString: '1',
  },
  [UiohookKey.Numpad2]: {
    name: 'Numpad2',
    isPrintable: true,
    string: '2',
    shiftString: '2',
  },
  [UiohookKey.Numpad3]: {
    name: 'Numpad3',
    isPrintable: true,
    string: '3',
    shiftString: '3',
  },
  [UiohookKey.Numpad4]: {
    name: 'Numpad4',
    isPrintable: true,
    string: '4',
    shiftString: '4',
  },
  [UiohookKey.Numpad5]: {
    name: 'Numpad5',
    isPrintable: true,
    string: '5',
    shiftString: '5',
  },
  [UiohookKey.Numpad6]: {
    name: 'Numpad6',
    isPrintable: true,
    string: '6',
    shiftString: '6',
  },
  [UiohookKey.Numpad7]: {
    name: 'Numpad7',
    isPrintable: true,
    string: '7',
    shiftString: '7',
  },
  [UiohookKey.Numpad8]: {
    name: 'Numpad8',
    isPrintable: true,
    string: '8',
    shiftString: '8',
  },
  [UiohookKey.Numpad9]: {
    name: 'Numpad9',
    isPrintable: true,
    string: '9',
    shiftString: '9',
  },

  [UiohookKey.NumpadMultiply]: {
    name: 'Multiply',
    isPrintable: true,
    string: '*',
    shiftString: '*',
  },
  [UiohookKey.NumpadAdd]: {
    name: 'Add',
    isPrintable: true,
    string: '+',
    shiftString: '+',
  },
  [UiohookKey.NumpadSubtract]: {
    name: 'Subtract',
    isPrintable: true,
    string: '-',
    shiftString: '-',
  },
  [UiohookKey.NumpadDivide]: {
    name: 'Divide',
    isPrintable: true,
    string: '/',
    shiftString: '/',
  },
  [UiohookKey.NumpadDecimal]: {
    name: 'Decimal',
    isPrintable: true,
    string: '.',
    shiftString: '.',
  },
  [UiohookKey.NumpadEnter]: {
    name: 'Enter',
    isPrintable: false,
  },
  [UiohookKey.NumpadEnd]: {
    name: 'End',
    isPrintable: false,
  },
  [UiohookKey.NumpadArrowDown]: {
    name: 'Down',
    isPrintable: false,
  },
  [UiohookKey.NumpadArrowLeft]: {
    name: 'Left',
    isPrintable: false,
  },
  [UiohookKey.NumpadArrowRight]: {
    name: 'Right',
    isPrintable: false,
  },
  [UiohookKey.NumpadArrowUp]: {
    name: 'Up',
    isPrintable: false,
  },
  [UiohookKey.NumpadPageDown]: {
    name: 'PageDown',
    isPrintable: false,
  },
  [UiohookKey.NumpadPageUp]: {
    name: 'PageUp',
    isPrintable: false,
  },
  [UiohookKey.NumpadInsert]: {
    name: 'Insert',
    isPrintable: false,
  },
  [UiohookKey.NumpadDelete]: {
    name: 'Delete',
    isPrintable: false,
  },
  [UiohookKey.F1]: {
    name: 'F1',
    isPrintable: false,
  },
  [UiohookKey.F2]: {
    name: 'F2',
    isPrintable: false,
  },
  [UiohookKey.F3]: {
    name: 'F3',
    isPrintable: false,
  },
  [UiohookKey.F4]: {
    name: 'F4',
    isPrintable: false,
  },
  [UiohookKey.F5]: {
    name: 'F5',
    isPrintable: false,
  },
  [UiohookKey.F6]: {
    name: 'F6',
    isPrintable: false,
  },
  [UiohookKey.F7]: {
    name: 'F7',
    isPrintable: false,
  },
  [UiohookKey.F8]: {
    name: 'F8',
    isPrintable: false,
  },
  [UiohookKey.F9]: {
    name: 'F9',
    isPrintable: false,
  },
  [UiohookKey.F10]: {
    name: 'F10',
    isPrintable: false,
  },
  [UiohookKey.F11]: {
    name: 'F11',
    isPrintable: false,
  },
  [UiohookKey.F12]: {
    name: 'F12',
    isPrintable: false,
  },
  [UiohookKey.F13]: {
    name: 'F13',
    isPrintable: false,
  },
  [UiohookKey.F14]: {
    name: 'F14',
    isPrintable: false,
  },
  [UiohookKey.F15]: {
    name: 'F15',
    isPrintable: false,
  },
  [UiohookKey.F16]: {
    name: 'F16',
    isPrintable: false,
  },
  [UiohookKey.F17]: {
    name: 'F17',
    isPrintable: false,
  },
  [UiohookKey.F18]: {
    name: 'F18',
    isPrintable: false,
  },
  [UiohookKey.F19]: {
    name: 'F19',
    isPrintable: false,
  },
  [UiohookKey.F20]: {
    name: 'F20',
    isPrintable: false,
  },
  [UiohookKey.F21]: {
    name: 'F21',
    isPrintable: false,
  },
  [UiohookKey.F22]: {
    name: 'F22',
    isPrintable: false,
  },
  [UiohookKey.F23]: {
    name: 'F23',
    isPrintable: false,
  },
  [UiohookKey.F24]: {
    name: 'F24',
    isPrintable: false,
  },
  [UiohookKey.Semicolon]: {
    name: 'Semicolon',
    isPrintable: true,
    string: ';',
    shiftString: ':',
  },
  [UiohookKey.Equal]: {
    name: 'Equal',
    isPrintable: true,
    string: '=',
    shiftString: '+',
  },
  [UiohookKey.Comma]: {
    name: 'Comma',
    isPrintable: true,
    string: ',',
    shiftString: '"',
  },
  [UiohookKey.Minus]: {
    name: 'Minus',
    isPrintable: true,
    string: '-',
    shiftString: '_',
  },
  [UiohookKey.Period]: {
    name: 'Period',
    isPrintable: true,
    string: '.',
    shiftString: '>',
  },
  [UiohookKey.Slash]: {
    name: 'Slash',
    isPrintable: true,
    string: '/',
    shiftString: '?',
  },
  [UiohookKey.Backquote]: {
    name: 'Grave',
    isPrintable: true,
    string: '`',
    shiftString: '~',
  },
  [UiohookKey.BracketLeft]: {
    name: 'LeftBracket',
    isPrintable: true,
    string: '[',
    shiftString: '{',
  },
  [UiohookKey.BracketRight]: {
    name: 'RightBracket',
    isPrintable: true,
    string: ']',
    shiftString: '}',
  },
  [UiohookKey.Backslash]: {
    name: 'Backslash',
    isPrintable: true,
    string: '\\',
    shiftString: '|',
  },
  [UiohookKey.Quote]: {
    name: 'Quote',
    isPrintable: true,
    string: "'",
    shiftString: '"',
  },
  [UiohookKey.Ctrl]: {
    name: 'LeftControl',
    isPrintable: false,
  },
  [UiohookKey.CtrlRight]: {
    name: 'RightControl',
    isPrintable: false,
  },
  [UiohookKey.Shift]: {
    name: 'LeftShift',
    isPrintable: false,
  },
  [UiohookKey.ShiftRight]: {
    name: 'RightShift',
    isPrintable: false,
  },
  [UiohookKey.Alt]: {
    name: 'LeftAlt',
    isPrintable: false,
  },
  [UiohookKey.AltRight]: {
    name: 'RightAlt',
    isPrintable: false,
  },
  [UiohookKey.Meta]: {
    name: 'LeftMeta',
    isPrintable: false,
  },
  [UiohookKey.MetaRight]: {
    name: 'RightMeta',
    isPrintable: false,
  },
  [UiohookKey.NumLock]: {
    name: 'NumLock',
    isPrintable: false,
  },
  [UiohookKey.ScrollLock]: {
    name: 'ScrollLock',
    isPrintable: false,
  },
  [UiohookKey.PrintScreen]: {
    name: 'Print',
    isPrintable: false,
  },

  [UiohookKey.A]: {
    name: 'A',
    isPrintable: true,
    string: 'a',
    shiftString: 'A',
  },
  [UiohookKey.B]: {
    name: 'B',
    isPrintable: true,
    string: 'b',
    shiftString: 'B',
  },
  [UiohookKey.C]: {
    name: 'C',
    isPrintable: true,
    string: 'c',
    shiftString: 'C',
  },
  [UiohookKey.D]: {
    name: 'D',
    isPrintable: true,
    string: 'd',
    shiftString: 'D',
  },
  [UiohookKey.E]: {
    name: 'E',
    isPrintable: true,
    string: 'e',
    shiftString: 'E',
  },
  [UiohookKey.F]: {
    name: 'F',
    isPrintable: true,
    string: 'f',
    shiftString: 'F',
  },
  [UiohookKey.G]: {
    name: 'G',
    isPrintable: true,
    string: 'g',
    shiftString: 'G',
  },
  [UiohookKey.H]: {
    name: 'H',
    isPrintable: true,
    string: 'h',
    shiftString: 'H',
  },
  [UiohookKey.I]: {
    name: 'I',
    isPrintable: true,
    string: 'i',
    shiftString: 'I',
  },
  [UiohookKey.J]: {
    name: 'J',
    isPrintable: true,
    string: 'j',
    shiftString: 'J',
  },
  [UiohookKey.K]: {
    name: 'K',
    isPrintable: true,
    string: 'k',
    shiftString: 'K',
  },
  [UiohookKey.L]: {
    name: 'L',
    isPrintable: true,
    string: 'l',
    shiftString: 'L',
  },
  [UiohookKey.M]: {
    name: 'M',
    isPrintable: true,
    string: 'm',
    shiftString: 'M',
  },
  [UiohookKey.N]: {
    name: 'N',
    isPrintable: true,
    string: 'n',
    shiftString: 'N',
  },
  [UiohookKey.O]: {
    name: 'O',
    isPrintable: true,
    string: 'o',
    shiftString: 'O',
  },
  [UiohookKey.P]: {
    name: 'P',
    isPrintable: true,
    string: 'p',
    shiftString: 'P',
  },
  [UiohookKey.Q]: {
    name: 'Q',
    isPrintable: true,
    string: 'q',
    shiftString: 'Q',
  },
  [UiohookKey.R]: {
    name: 'R',
    isPrintable: true,
    string: 'r',
    shiftString: 'R',
  },
  [UiohookKey.S]: {
    name: 'S',
    isPrintable: true,
    string: 's',
    shiftString: 'S',
  },
  [UiohookKey.T]: {
    name: 'T',
    isPrintable: true,
    string: 't',
    shiftString: 'T',
  },
  [UiohookKey.U]: {
    name: 'U',
    isPrintable: true,
    string: 'u',
    shiftString: 'U',
  },
  [UiohookKey.V]: {
    name: 'V',
    isPrintable: true,
    string: 'v',
    shiftString: 'V',
  },
  [UiohookKey.W]: {
    name: 'W',
    isPrintable: true,
    string: 'w',
    shiftString: 'W',
  },
  [UiohookKey.X]: {
    name: 'X',
    isPrintable: true,
    string: 'x',
    shiftString: 'X',
  },
  [UiohookKey.Y]: {
    name: 'Y',
    isPrintable: true,
    string: 'y',
    shiftString: 'Y',
  },
  [UiohookKey.Z]: {
    name: 'Z',
    isPrintable: true,
    string: 'z',
    shiftString: 'Z',
  },

  [UiohookKey[0]]: {
    name: '0',
    isPrintable: true,
    string: '0',
    shiftString: ')',
  },
  [UiohookKey[1]]: {
    name: '1',
    isPrintable: true,
    string: '1',
    shiftString: '!',
  },
  [UiohookKey[2]]: {
    name: '2',
    isPrintable: true,
    string: '2',
    shiftString: '@',
  },
  [UiohookKey[3]]: {
    name: '3',
    isPrintable: true,
    string: '3',
    shiftString: '#',
  },
  [UiohookKey[4]]: {
    name: '4',
    isPrintable: true,
    string: '4',
    shiftString: '$',
  },
  [UiohookKey[5]]: {
    name: '5',
    isPrintable: true,
    string: '5',
    shiftString: '%',
  },
  [UiohookKey[6]]: {
    name: '6',
    isPrintable: true,
    string: '6',
    shiftString: '^',
  },
  [UiohookKey[7]]: {
    name: '7',
    isPrintable: true,
    string: '7',
    shiftString: '&',
  },
  [UiohookKey[8]]: {
    name: '8',
    isPrintable: true,
    string: '8',
    shiftString: '*',
  },
  [UiohookKey[9]]: {
    name: '9',
    isPrintable: true,
    string: '9',
    shiftString: '(',
  },

  [133]: {
    name: 'LeftSuper',
    isPrintable: false,
  },
  [134]: {
    name: 'RightSuper',
    isPrintable: false,
  },
  [0]: {
    name: 'Alt',
    isPrintable: false,
  },
};
