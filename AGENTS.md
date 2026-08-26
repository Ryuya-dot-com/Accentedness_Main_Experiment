# このrepositoryでのmulti-agent設計gate

このrepositoryで設計または実装を変更するtaskでは、multi-agent modeが利用できる限り、主担当とは独立したread-onlyの`essentiality_critic` agentを毎回置く。

1. 実装前に、提案する各構成要素・前提を`KEEP` / `SIMPLIFY` / `REMOVE`へ分類させる。
2. `KEEP`には「それを削除すると、どの明示要件・データ完全性・参加者安全性が具体的に壊れるか」を1文で要求する。具体化できないものは残さない。
3. participant向け視点と研究者向け視点の混在、testだけが支える未使用実装、将来の刺激曝露・データ汚染、randomizationの破綻、過剰な運用機構を敵対的に点検させる。
4. criticはscopeを勝手に広げない。現在の機能・データ完全性・ユーザーの明示要件に直接関係しない研究ガバナンスや一般公開・商用運用を持ち込まない。
5. 実装後かつcommit前にfull diffを同じcriticへ再提示し、`PASS`または具体的な`BLOCK`を得る。未解消の`BLOCK`がある間はcommit・push・deployしない。
6. 新しい設計・実装taskを始める時点で、`ROADMAP.html`の本質性レビューgateをuncheckedへ戻し、そのtaskの最終`PASS`後だけcheckedにする。`PASS`を反映するchecked属性だけの変更は再レビュー対象外とする。remote実測を伴う別gateは、その実測なしにcheckedへ流用しない。
