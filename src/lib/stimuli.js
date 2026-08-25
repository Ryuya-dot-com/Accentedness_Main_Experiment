export const MAIN_STIMULI = Object.freeze([
  { id: 1, word: "casket", gloss: "棺", list: 1, listRank: 0 },
  { id: 2, word: "catapult", gloss: "投石機", list: 1, listRank: 1 },
  { id: 3, word: "chisel", gloss: "彫刻刀", list: 1, listRank: 2 },
  { id: 4, word: "cocoon", gloss: "繭", list: 1, listRank: 3 },
  { id: 5, word: "faucet", gloss: "蛇口", list: 1, listRank: 4 },
  { id: 6, word: "ladle", gloss: "おたま", list: 1, listRank: 5 },
  { id: 7, word: "persimmon", gloss: "柿", list: 1, listRank: 6 },
  { id: 8, word: "protractor", gloss: "分度器", list: 1, listRank: 7 },
  { id: 9, word: "tadpole", gloss: "オタマジャクシ", list: 1, listRank: 8 },
  { id: 10, word: "toboggan", gloss: "そり", list: 1, listRank: 9 },
  { id: 11, word: "tweezers", gloss: "ピンセット", list: 1, listRank: 10 },
  { id: 12, word: "wardrobe", gloss: "タンス", list: 1, listRank: 11 },
  { id: 13, word: "acorn", gloss: "どんぐり", list: 2, listRank: 0 },
  { id: 14, word: "capelin", gloss: "ししゃも", list: 2, listRank: 1 },
  { id: 15, word: "icicle", gloss: "つらら", list: 2, listRank: 2 },
  { id: 16, word: "loquat", gloss: "ビワ", list: 2, listRank: 3 },
  { id: 17, word: "mantis", gloss: "カマキリ", list: 2, listRank: 4 },
  { id: 18, word: "parakeet", gloss: "インコ", list: 2, listRank: 5 },
  { id: 19, word: "porcupine", gloss: "ヤマアラシ", list: 2, listRank: 6 },
  { id: 20, word: "rickshaw", gloss: "人力車", list: 2, listRank: 7 },
  { id: 21, word: "scallop", gloss: "ホタテ", list: 2, listRank: 8 },
  { id: 22, word: "scalpel", gloss: "メス", list: 2, listRank: 9 },
  { id: 23, word: "syringe", gloss: "注射器", list: 2, listRank: 10 },
  { id: 24, word: "treadmill", gloss: "ランニングマシン", list: 2, listRank: 11 },
]);

export const PICTURE_NAMING_PRACTICE_STIMULI = Object.freeze([
  { id: 901, word: "abacus", gloss: "そろばん" },
  { id: 902, word: "binoculars", gloss: "双眼鏡" },
]);

export const L2_TO_L1_PRACTICE_STIMULI = Object.freeze([
  { id: 903, word: "thermometer", gloss: "温度計" },
  { id: 904, word: "xylophone", gloss: "木琴" },
  { id: 905, word: "detergent", gloss: "洗剤" },
]);

export const ACCENTS = Object.freeze(["english", "chinese", "japanese"]);

export const ACCENT_CODES = Object.freeze({
  english: "E",
  chinese: "C",
  japanese: "J",
});

export const TEST_TALKERS = Object.freeze({
  english: "e_test_f1",
  chinese: "c_test_f1",
  japanese: "j_test_f1",
});

// The three fixed female test voices are also used for L2-to-L1 practice.
export const PRACTICE_TEST_TALKERS = TEST_TALKERS;

export const TRAINING_TALKERS = Object.freeze({
  english: Object.freeze(["e1", "e2", "e3", "e4", "e5", "e6"]),
  chinese: Object.freeze(["c1", "c2", "c3", "c4", "c5", "c6"]),
  japanese: Object.freeze(["j1", "j2", "j3", "j4", "j5", "j6"]),
});
