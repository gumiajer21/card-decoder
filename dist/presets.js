/*
 * 卡片解码者活动预设接口
 * 以后新增官方活动时，只需在数组中追加一个对象；id 请保持唯一。
 */
window.ACTIVITY_PRESETS = [
  {
    id: 'master-duel-2026-09',
    name: '大师决斗 · 卡片解码者（9题）',
    config: {
      puzzles: 9,
      totalHints: 11,
      totalChallenges: 36,
      premiumPuzzles: 3,
      milestones: [
        { matches: 1, points: 10 },
        { matches: 3, points: 10 },
        { matches: 5, points: 10 },
      ],
      solvePoints: 70,
      regularMatchPoints: 1,
      regularSolvePoints: 0,
    },
  },
];
