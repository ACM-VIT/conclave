const VISIBLE_CHARACTER =
  /(?![\s\p{Default_Ignorable_Code_Point}\u2800])[\p{Grapheme_Base}\p{Co}\p{Cn}\u0600-\u0605\u06DD\u070F\u0890\u0891\u08E2\u{110BD}\u{110CD}]/u;

export const hasVisibleText = (text: string): boolean => VISIBLE_CHARACTER.test(text);
