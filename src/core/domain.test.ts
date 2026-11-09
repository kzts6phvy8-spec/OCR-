import { describe, expect, it } from "vitest";
import {
  decideSpecial,
  meishoSlotFromEffect,
  detectTalentOrder,
  fixTalentOrder,
  learnTalentStats,
  talentKind,
  talentRules,
  emptyWarlordInput,
  extractionToPatch,
  mergeWarlord,
  normalizeFaction,
  normalizeInput,
  normalizeName,
  normalizePriority,
  splitAwakeningName,
} from "./domain.ts";
import { makeExtraction } from "./testUtils.ts";

describe("normalizeName", () => {
  it("接頭辞と【特】表記を除去する", () => {
    expect(normalizeName("【SSR】武将A")).toEqual({ name: "武将A", hasSpecialMarker: false });
    expect(normalizeName("【特】武将A")).toEqual({ name: "武将A", hasSpecialMarker: true });
  });
});

describe("decideSpecial", () => {
  it("画面の【特】表記で特異と判定", () => {
    const ext = makeExtraction({ name: "武将A", special_marker_visible: true });
    expect(decideSpecial(ext, "auto").is_special).toBe(true);
  });
  it("表記が無ければ通常", () => {
    expect(decideSpecial(makeExtraction({ name: "武将A" }), "auto").is_special).toBe(false);
  });
  it("手動指定が最優先", () => {
    const ext = makeExtraction({ name: "武将A", special_marker_visible: true });
    const d = decideSpecial(ext, "force_normal");
    expect(d.is_special).toBe(false);
    expect(d.warnings.length).toBe(1);
    expect(decideSpecial(makeExtraction({ name: "武将A" }), "force_special").is_special).toBe(true);
  });
});

describe("extractionToPatch", () => {
  it("写っていない項目は patch に含めない", () => {
    const patch = extractionToPatch(makeExtraction({ name: "武将A", level: 80 }));
    expect(patch).toEqual({ level: 80 });
  });
  it("覚醒名から優先度を分離し、武器覚醒は写っている時だけ採用", () => {
    const patch = extractionToPatch(
      makeExtraction({
        awakening: {
          visible: true,
          skill_name: "覚醒A(極高)",
          before_weapon_effect: "前",
          weapon_awakening_visible: false,
          after_weapon_effect: "AIが補った後効果",
        },
      }),
    );
    expect(patch.awakening_skill_name).toBe("覚醒A");
    expect(patch.awakening_priority).toBe("極高");
    expect(patch.has_weapon_awakening).toBeUndefined();
    expect(patch.awakening_after_weapon).toBeUndefined();
  });
  it("発動優先度を「甲・1」の形にそろえる", () => {
    expect(normalizePriority("丁·4")).toBe("丁・4");
    expect(normalizePriority("（癸・10）")).toBe("癸・10");
    expect(normalizePriority("壬9")).toBe("壬・9");
    expect(normalizePriority("乙")).toBe("乙・2");
    expect(normalizePriority("3")).toBe("丙・3");
    expect(normalizePriority("低")).toBe("低");
    expect(normalizePriority("11")).toBe("");
    expect(normalizePriority("不明")).toBe("");
    expect(splitAwakeningName("覚醒B（戊·5）")).toEqual({ name: "覚醒B", priority: "戊・5" });
    expect(splitAwakeningName("覚醒C(特別)")).toEqual({ name: "覚醒C(特別)", priority: "" });
    const old = { ...emptyWarlordInput(), name: "武将A", awakening_priority: "低" };
    const { merged, warnings } = mergeWarlord(old, { awakening_priority: "丁・4" });
    expect(merged.awakening_priority).toBe("丁・4");
    expect(warnings).toEqual([]);
  });
  it("優先度が無い・古い表記なら覚醒スキルの発動条件から判断する", () => {
    const make = (awakening_priority: string, awakening_before_weapon: string) =>
      normalizeInput({ name: "武将A", has_awakening: true, awakening_priority, awakening_before_weapon }).awakening_priority;
    expect(make("低", "戦闘進入時、自身の攻+20%")).toBe("甲・1");
    expect(make("", "敵部隊が撃破された後、自身の兵力を回復")).toBe("乙・2");
    expect(make("高", "撃破された後、味方全体に防壁")).toBe("甲・1");
    expect(make("中", "味方部隊（自身を除く）の通常攻撃が終了した後、追撃する")).toBe("辛・8");
    expect(make("", "自身が行動した後(覚醒&突破スキル・重撃による行動を除く)、…")).toBe("丁・4");
    expect(make("極高", "通常攻撃or奥義スキルで相手の兵力を55%以下に減らせると、…")).toBe("戊・5");
    expect(make("", "【覚醒】敵が覚醒スキルを2回発動する度に、…")).toBe("癸・10");
    // 一覧に無い条件はそのまま、新しい表記はそのまま
    expect(make("低", "よくわからない条件で、…")).toBe("低");
    expect(make("壬・9", "戦闘進入時、…")).toBe("壬・9");
  });
  it("成長率に符号を付ける", () => {
    const patch = extractionToPatch(makeExtraction({ attack: { base: 120, growth: "2.6" } }));
    expect(patch.attack_growth).toBe("+2.6");
    expect(patch.attack_base).toBe(120);
  });
});

describe("mergeWarlord", () => {
  const base = { ...emptyWarlordInput(), name: "武将A", skill_name: "スキルA", level: 60, gallery_images: ["/a.png"], image_url: "/a.png" };

  it("空欄を埋め、既存値は保持して警告", () => {
    const { merged, warnings } = mergeWarlord(base, { skill_name: "誤読", title_alias: "二つ名A", gallery_images: ["/b.png"] });
    expect(merged.skill_name).toBe("スキルA");
    expect(merged.title_alias).toBe("二つ名A");
    expect(merged.gallery_images).toEqual(["/a.png", "/b.png"]);
    expect(merged.image_url).toBe("/a.png");
    expect(warnings).toHaveLength(1);
  });
  it("Lv は大きい方、天賦は星ごとに統合", () => {
    const first = mergeWarlord(base, {
      level: 50,
      talents: [{ star_level: 1, position: "", name: "天賦A", effect: "攻+5", unlocked: true }],
    }).merged;
    expect(first.level).toBe(60);
    const second = mergeWarlord(first, {
      talents: [
        { star_level: 1, position: "上", name: "天賦A", effect: "攻+5%（部隊）", unlocked: false },
        { star_level: 2, position: "", name: "天賦B", effect: "防+5", unlocked: false },
      ],
    }).merged;
    expect(second.talents).toEqual([
      { star_level: 1, position: "上", name: "天賦A", effect: "攻+5%（部隊）", unlocked: true },
      { star_level: 2, position: "", name: "天賦B", effect: "防+5", unlocked: false },
    ]);
  });
  it("連携スキルを相方ごとに統合", () => {
    const first = mergeWarlord(base, { synergy_skills: [{ partner: "武将B", effect: "短" }] }).merged;
    const second = mergeWarlord(first, {
      synergy_skills: [
        { partner: "武将B", effect: "より長い効果" },
        { partner: "武将C", effect: "x" },
      ],
    }).merged;
    expect(second.synergy_skills.map((s) => s.partner)).toEqual(["武将B", "武将C"]);
    expect(second.synergy_skills[0].effect).toBe("より長い効果");
  });
});

describe("misc normalizers", () => {
  it("勢力の表記揺れ", () => {
    expect(normalizeFaction("奥関甲")).toBe("奥.関.甲");
    expect(normalizeFaction("中・九")).toBe("中.九");
    expect(normalizeFaction("東海")).toBe("東海");
    expect(normalizeFaction("謎")).toBe("");
  });
  it("覚醒名の優先度分離", () => {
    expect(splitAwakeningName("覚醒A（高）")).toEqual({ name: "覚醒A", priority: "高" });
  });
});

describe("勢力", () => {
  it("物語武将を読み取れる", () => {
    expect(normalizeFaction("物語武将")).toBe("物語武将");
    expect(normalizeFaction("物語")).toBe("物語武将");
    expect(normalizeFaction("コラボ武将")).toBe("コラボ武将");
    expect(normalizeFaction("コラボ")).toBe("コラボ武将");
  });
});

describe("連携スキルの統合", () => {
  it("同じ相手でも効果が違う段階は別々に残す", async () => {
    const { mergeSynergies } = await import("./domain.ts");
    const one = { partner: "鬼憑徳川四天王", effect: "鬼憑徳川四天王1体以上が場内にいる場合、物理防御+15%" };
    const two = { partner: "鬼憑徳川四天王", effect: "鬼憑徳川四天王2体以上が場内にいる場合、通常攻撃ダメージ+30%" };
    expect(mergeSynergies([one], [two])).toEqual([one, two]);
    // 途切れて短く読めたものは同じとみなし、長い方を残す
    expect(mergeSynergies([{ ...two, effect: "鬼憑徳川四天王2体以上が場内にいる場合、通常攻" }], [two])).toEqual([two]);
    // 相手の並び順違いは同じ
    expect(mergeSynergies([{ partner: "A、B", effect: "x" }], [{ partner: "B、A", effect: "x" }])).toHaveLength(1);
  });
});

describe("天賦の効果", () => {
  it("名前を取り除いて効果と数値だけにする (効果の一部は削らない)", async () => {
    const { talentEffect, normalizeInput, emptyWarlordInput } = await import("./domain.ts");
    expect(talentEffect("固守:物理防御+30%")).toBe("物理防御+30%");
    expect(talentEffect("力戦：物理攻撃+18%")).toBe("物理攻撃+18%");
    expect(talentEffect("気勢 奥義ゲージ+1", "気勢")).toBe("奥義ゲージ+1");
    expect(talentEffect("物理防御+30%")).toBe("物理防御+30%");
    expect(talentEffect("物理攻撃:+18%")).toBe("物理攻撃:+18%");
    expect(talentEffect("計略ダメージ:10%軽減")).toBe("計略ダメージ:10%軽減");
    expect(talentEffect("騎兵 攻撃+10%")).toBe("騎兵 攻撃+10%");
    // 保存し直しても効果は変わらない
    const once = normalizeInput({ ...emptyWarlordInput(), name: "A", talents: [{ star_level: 1, position: "", name: "", effect: "開戦時 物理防御+30%", unlocked: true }] });
    expect(normalizeInput(normalizeInput(once)).talents[0].effect).toBe("開戦時 物理防御+30%");
  });
});

describe("天賦の星の番号", () => {
  it("画面の位置から星を決め、前の版の並べ替えは元に戻せる", async () => {
    const { starFromPosition, undoTalentReorder, extractionToPatch } = await import("./domain.ts");
    const { makeExtraction } = await import("./testUtils.ts");
    expect(["1段目左", "1段目右", "2段目左", "2段目右", "3段目"].map(starFromPosition)).toEqual([1, 2, 3, 4, 5]);
    expect(["星一解放", "星二解放", "星三解放", "星四解放", "星五解放"].map(starFromPosition)).toEqual([1, 2, 3, 4, 5]);
    const patch = extractionToPatch(makeExtraction({ talents: [{ star_level: 9, position: "2段目右", name: "", effect: "回避+15%", unlocked: true }] }));
    expect(patch.talents?.[0].star_level).toBe(4);
    // お宮: 正しかった並び (計攻・会心・兵数・計ダメ・ダメ) が、前の版の並べ替えで 計攻・計ダメ・会心・ダメ・兵数 になっていた
    const broken = ["計略攻撃+30%", "計略ダメージ+45%", "通常会心+45%", "ダメージ+25%", "兵数上限+30%"].map((effect, i) => ({
      star_level: i + 1,
      position: "",
      name: "",
      effect,
      unlocked: true,
    }));
    expect(undoTalentReorder(broken).map((t) => t.effect)).toEqual(["計略攻撃+30%", "通常会心+45%", "兵数上限+30%", "計略ダメージ+45%", "ダメージ+25%"]);
  });
});

describe("天賦の並びのずれを見分ける", () => {
  const make = (flags: boolean[]) => flags.map((u, i) => ({ star_level: i + 1, position: "", name: "", effect: `効果${i + 1}`, unlocked: u }));
  it("列の順番 (星 1・3・5・2・4) で入っていると分かる", () => {
    // 星2 まで解放: 正しくは 〇〇××× → 列の順番だと 〇××〇×
    expect(detectTalentOrder(make([true, false, false, true, false]))).toBe("column");
  });
  it("正しい並びはそのまま", () => {
    expect(detectTalentOrder(make([true, true, true, false, false]))).toBe("ok");
  });
  it("左右逆の読み取りと区別できない時は決めない", () => {
    // 星2 まで: 正しい並びと左右逆のどちらでも筋が通る
    expect(detectTalentOrder(make([true, true, false, false, false]))).toBe("unknown");
    // 星3 まで: 列の順番と左右逆のどちらでも筋が通る
    expect(detectTalentOrder(make([true, true, false, true, false]))).toBe("unknown");
  });
  it("星4 まで解放で列の順番なら分かる", () => {
    expect(detectTalentOrder(make([true, true, false, true, true]))).toBe("column");
  });
  it("全部解放済みなら見分けられない", () => {
    expect(detectTalentOrder(make([true, true, true, true, true]))).toBe("unknown");
    expect(detectTalentOrder(make([true, true, true]))).toBe("unknown");
  });
});

describe("天賦の並びを効果の中身から見分ける", () => {
  // 正しい星1〜5 の効果。見破りは星2、奥義ゲージは星3 にあることが多い
  const real = ["計攻+10%", "見破り+15%", "奥義ゲージ+1", "計ダメ+10%", "ダメ+10%"];
  const build = (map: number[]) =>
    // map[保存された番号] = 本当の星
    [1, 2, 3, 4, 5].map((stored) => ({ star_level: stored, position: "", name: "", effect: real[map[stored] - 1], unlocked: true }));
  it("全部解放済みでも、列の順番なら分かって直せる", () => {
    const talents = build([0, 1, 3, 5, 2, 4]);
    expect(detectTalentOrder(talents)).toBe("column");
    expect(fixTalentOrder(talents, "column").map((t) => t.effect)).toEqual(real);
  });
  it("左右逆も分かって直せる", () => {
    const talents = build([0, 2, 1, 4, 3, 5]);
    expect(detectTalentOrder(talents)).toBe("swapped");
    expect(fixTalentOrder(talents, "swapped").map((t) => t.effect)).toEqual(real);
  });
  it("正しい並びは ok", () => {
    expect(detectTalentOrder(build([0, 1, 2, 3, 4, 5]))).toBe("ok");
  });
  it("手がかりになる効果が無ければ決めない", () => {
    const talents = [1, 2, 3, 4, 5].map((n) => ({ star_level: n, position: "", name: "", effect: `攻+${n}%`, unlocked: true }));
    expect(detectTalentOrder(talents)).toBe("unknown");
  });
});

describe("並びが確かな武将から天賦の法則を学ぶ", () => {
  const row = (effects: string[]) => effects.map((e, i) => ({ star_level: i + 1, position: "", name: "", effect: e, unlocked: true }));
  const known = Array.from({ length: 6 }, (_, i) => row([`物理防御+${10 + i}%`, "計攻+10%", "兵数上限+500", "計ダメ+10%", "ダメージ軽減+5%"]));
  it("効果の種類は数値を除いて比べる", () => {
    expect(talentKind("物理防御+30%")).toBe("物理防御");
  });
  it("はっきりした法則を見つける", () => {
    const rules = talentRules(learnTalentStats(known));
    expect(rules.find((r) => r.kind === "物理防御")).toMatchObject({ star: 1, share: 1, count: 6 });
  });
  it("学んだ法則で、手がかりの決まりが無い効果でも並びのずれを直せる", () => {
    const stats = learnTalentStats(known);
    const real = ["物理防御+30%", "計攻+20%", "兵数上限+800", "計ダメ+12%", "ダメージ軽減+8%"];
    const column = [0, 1, 3, 5, 2, 4];
    const talents = [1, 2, 3, 4, 5].map((stored) => ({ star_level: stored, position: "", name: "", effect: real[column[stored] - 1], unlocked: true }));
    expect(detectTalentOrder(talents, stats)).toBe("column");
    expect(detectTalentOrder(row(real), stats)).toBe("ok");
  });
});

describe("名将", () => {
  it("奥義スキルの欄の右上の「名将一覧」で印が付き、名前や奥義スキルからは外す", () => {
    expect(extractionToPatch(makeExtraction({ meisho_marker_visible: true })).is_meisho).toBe(true);
    const patch = extractionToPatch(makeExtraction({ skill: { name: "天下布武 名将一覧", gauge: 2, desc: "敵全体に攻撃" } }));
    expect(patch.is_meisho).toBe(true);
    expect(patch.skill_name).toBe("天下布武");
    expect(normalizeName("真田幸村名将一覧").name).toBe("真田幸村");
  });
  it("「〜の名将」のような二つ名だけでは名将にしない", () => {
    const patch = extractionToPatch(makeExtraction({ name: "上杉謙信", title_alias: "越後の名将" }));
    expect(patch.is_meisho).toBeUndefined();
    expect(patch.title_alias).toBe("越後の名将");
  });
  it("手で「名将ではない」と決めた武将には、読み取りで印を付けない", () => {
    const base = normalizeInput({ ...emptyWarlordInput(), name: "織田信長", is_meisho: false, meisho_manual: true });
    expect(mergeWarlord(base, extractionToPatch(makeExtraction({ meisho_marker_visible: true }))).merged.is_meisho).toBe(false);
  });
  it("一度付いた印は、写っていない画像で外さない", () => {
    const base = normalizeInput({ ...emptyWarlordInput(), name: "日野富子", is_meisho: true });
    expect(mergeWarlord(base, extractionToPatch(makeExtraction({ name: "日野富子" }))).merged.is_meisho).toBe(true);
  });
});

describe("名将修行の追加天賦", () => {
  it("選ばれている丸の追加天賦を読み、名将の印も付ける", () => {
    const patch = extractionToPatch(
      makeExtraction({ meisho_training: { visible: true, selected_rank: "少史", selected_slot: "上", effect: "兵数上限+175.(未修行)", trained: false } }),
    );
    expect(patch.is_meisho).toBe(true);
    expect(patch.meisho_talents).toEqual([{ rank: "少史", slot: "上", effect: "兵数上限+175", trained: false }]);
  });
  it("丸ごとのスクショを足すと増え、段階の順に並ぶ。修行済みになったら更新する", () => {
    const base = normalizeInput({ ...emptyWarlordInput(), name: "南部晴政" });
    const read = (rank: string, slot: string | null, effect: string, trained: boolean) =>
      extractionToPatch(makeExtraction({ meisho_training: { visible: true, selected_rank: rank, selected_slot: slot, effect, trained } }));
    let w = mergeWarlord(base, read("大史", null, "計略攻撃+5%", false)).merged;
    w = mergeWarlord(w, read("少史", "下", "物理防御+3%", false)).merged;
    w = mergeWarlord(w, read("少史", "上", "兵数上限+175", false)).merged;
    w = mergeWarlord(w, read("少史", "上", "兵数上限+175", true)).merged;
    expect(w.meisho_talents?.map((t) => `${t.rank}${t.slot}:${t.trained}`)).toEqual(["少史上:true", "少史下:false", "大史:false"]);
  });
  it("段階が分からない読み取りは入れない", () => {
    expect(extractionToPatch(makeExtraction({ meisho_training: { visible: true, selected_rank: null, selected_slot: null, effect: "攻+5%", trained: true } })).meisho_talents).toBeUndefined();
  });
});

describe("名将修行のテキスト", async () => {
  const { meishoTrainingToText } = await import("./text.ts");
  it("勢力ごとに官職と追加天賦を並べ、未取得も分かる", () => {
    const a = { ...normalizeInput({ ...emptyWarlordInput(), name: "南部晴政", faction: "奥.関.甲", is_special: true, is_meisho: true, meisho_talents: [{ rank: "少史", slot: "上", effect: "兵数上限+175", trained: false }] }), id: "a" };
    const b = { ...normalizeInput({ ...emptyWarlordInput(), name: "武田信玄", faction: "奥.関.甲", is_meisho: true }), id: "b" };
    const text = meishoTrainingToText([a, b] as never);
    expect(text).toContain("■ 奥.関.甲\n【特】南部晴政\n  少史 上:兵数上限+175 (未修行)");
    expect(text).toContain("武田信玄\n  未取得");
  });
});

describe("名将修行の丸の位置を効果から決める", () => {
  it("効果の種類で位置が決まるものは、AI の読んだ位置より優先する", () => {
    expect(meishoSlotFromEffect("兵数上限+175")).toEqual({ rank: "少史", slot: "上" });
    expect(meishoSlotFromEffect("物理計略防御+20%")).toEqual({ rank: "少納言", slot: "下" });
    expect(meishoSlotFromEffect("覚醒スキルでの被ダメージ軽減+20%")).toEqual({ rank: "中納言", slot: "下" });
    expect(meishoSlotFromEffect("自身の覚醒スキル初回発動後、奥義ゲージ+2、スキル会心+40%")).toEqual({ rank: "大輔", slot: "" });
    expect(meishoSlotFromEffect("戦闘進入時、自身に頓悟を付与")).toEqual({ rank: "大史", slot: "" });
    const patch = extractionToPatch(
      makeExtraction({ meisho_training: { visible: true, selected_rank: "大史", selected_slot: null, effect: "兵数上限+175", trained: true } }),
    );
    expect(patch.meisho_talents?.[0]).toMatchObject({ rank: "少史", slot: "上" });
  });
  it("どちらの丸にもある効果は決めない", () => {
    expect(meishoSlotFromEffect("最終ダメージ軽減+15%")).toBeNull();
    expect(meishoSlotFromEffect("自身の兵力が50%未満の場合、攻撃回復+15%")).toBeNull();
  });
});

describe("シミュレーターに直接渡した名将修行", async () => {
  const { simMeishoTalents, simMeishoNotIn, SIM_MEISHO } = await import("./meishoSimData.ts");
  it("46 人分あり、どれも丸 8 つ", () => {
    expect(SIM_MEISHO).toHaveLength(46);
    expect(SIM_MEISHO.every((m) => m.effects.length === 8)).toBe(true);
  });
  it("勢力と名前で合わせる (同じ名前が 2 人いる名将は通常/特異でも)", () => {
    expect(simMeishoTalents({ faction: "旧時代", name: "日野富子", is_special: false })?.[0]).toMatchObject({ rank: "少史", slot: "上", effect: "兵数上限+175" });
    expect(simMeishoTalents({ faction: "東海", name: "江姫", is_special: true })?.[1].effect).toBe("奥義ダメージUP+25%");
    expect(simMeishoTalents({ faction: "東海", name: "江姫", is_special: false })?.[1].effect).toBe("通常攻撃ダメージ軽減+20%");
    expect(simMeishoTalents({ faction: "コラボ武将", name: "伊達政宗", is_special: false })).toBeNull();
  });
  it("図鑑にいない名将も分かる", () => {
    expect(simMeishoNotIn([{ faction: "旧時代", name: "日野富子", is_special: false }])).toHaveLength(45);
  });
});
