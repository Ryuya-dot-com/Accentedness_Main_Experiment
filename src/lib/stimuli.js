export const MAIN_STIMULI = Object.freeze([
  { id: 1, word: "tweezers", gloss: "ピンセット", list: 1, listRank: 0 },
  { id: 2, word: "scapula", gloss: "肩甲骨", list: 1, listRank: 1 },
  { id: 3, word: "cocoon", gloss: "繭", list: 1, listRank: 2 },
  { id: 4, word: "lotus", gloss: "蓮", list: 1, listRank: 3 },
  { id: 5, word: "xylophone", gloss: "木琴", list: 1, listRank: 4 },
  { id: 6, word: "porcupine", gloss: "ヤマアラシ", list: 1, listRank: 5 },
  { id: 7, word: "carousel", gloss: "回転木馬", list: 1, listRank: 6 },
  { id: 8, word: "spatula", gloss: "へら", list: 1, listRank: 7 },
  { id: 9, word: "syringe", gloss: "注射器", list: 1, listRank: 8 },
  { id: 10, word: "catapult", gloss: "投石機", list: 1, listRank: 9 },
  { id: 11, word: "wardrobe", gloss: "洋服だんす", list: 1, listRank: 10 },
  { id: 12, word: "abacus", gloss: "そろばん", list: 1, listRank: 11 },
  { id: 13, word: "razor", gloss: "かみそり", list: 2, listRank: 0 },
  { id: 14, word: "podium", gloss: "演台", list: 2, listRank: 1 },
  { id: 15, word: "protractor", gloss: "分度器", list: 2, listRank: 2 },
  { id: 16, word: "acorn", gloss: "どんぐり", list: 2, listRank: 3 },
  { id: 17, word: "scalpel", gloss: "メス", list: 2, listRank: 4 },
  { id: 18, word: "casket", gloss: "棺", list: 2, listRank: 5 },
  { id: 19, word: "detergent", gloss: "洗剤", list: 2, listRank: 6 },
  { id: 20, word: "nostril", gloss: "鼻孔", list: 2, listRank: 7 },
  { id: 21, word: "binoculars", gloss: "双眼鏡", list: 2, listRank: 8 },
  { id: 22, word: "raccoon", gloss: "アライグマ", list: 2, listRank: 9 },
  { id: 23, word: "parakeet", gloss: "インコ", list: 2, listRank: 10 },
  { id: 24, word: "toupee", gloss: "かつら", list: 2, listRank: 11 },
]);

// Learning-only familiarization items. They use English words that never enter
// the 24-word experimental pool; the emoji, rather than the written word, is
// shown to participants.
export const LEARNING_PRACTICE_STIMULI = Object.freeze([
  { id: 906, word: "apple", gloss: "りんご", emoji: "🍎" },
  { id: 907, word: "orange", gloss: "オレンジ", emoji: "🍊" },
]);

// Fixed American-English offline TTS voice used for familiarization and the
// untrained controls. It is not a main learning or test talker.
export const PRACTICE_TALKER = "tts_us_bella";

export const PICTURE_NAMING_PRACTICE_STIMULI = Object.freeze([
  { id: 901, word: "dog", gloss: "犬" },
  { id: 902, word: "chair", gloss: "椅子" },
]);

export const L2_TO_L1_PRACTICE_STIMULI = Object.freeze([
  { id: 903, word: "book", gloss: "本" },
  { id: 904, word: "water", gloss: "水" },
  { id: 905, word: "house", gloss: "家" },
]);

export const L2_TO_L1_CONTROL_STIMULI = Object.freeze([
  { id: 908, word: "strawberry", gloss: "いちご" },
  { id: 909, word: "grape", gloss: "ぶどう" },
  { id: 910, word: "pineapple", gloss: "パイナップル" },
  { id: 911, word: "peach", gloss: "桃" },
  { id: 912, word: "kiwi", gloss: "キウイ" },
  { id: 913, word: "cherry", gloss: "さくらんぼ" },
]);

export const L2_TO_L1_CONTROL_TALKER = PRACTICE_TALKER;

export const ACCENTS = Object.freeze(["english", "chinese", "japanese"]);

export const ACCENT_CODES = Object.freeze({
  english: "E",
  chinese: "C",
  japanese: "J",
});

export const TEST_TALKERS = Object.freeze({
  english: "E6_Audio",
  chinese: "C11_Natural",
  japanese: "J5_Natural",
});

export const TRAINING_TALKERS = Object.freeze({
  english: Object.freeze(["E1_Audio", "E4_Audio", "E7_Audio", "E12_Audio", "E13_Audio", "E14_Audio"]),
  chinese: Object.freeze(["C2_Natural", "C5_Natural", "C7_Natural", "C15_Natural", "C16_Natural", "C18_Natural"]),
  japanese: Object.freeze(["J6_Natural", "J8_Natural", "J4_Natural", "J12_Natural", "J10_Natural", "J15_Natural"]),
});
