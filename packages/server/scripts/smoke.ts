/**
 * 端到端冒烟测试：不启动 HTTP / MCP，直接驱动会话状态机走完整闭环。
 * 用于验证「主 Agent 阻塞等待 ↔ 用户裁决回灌」这条核心链路是否真的通。
 *
 * 运行：npm run smoke -w @clarifyai/server
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { FeedbackBroker } from '../src/core/feedbackBroker.js';
import { SessionService } from '../src/core/sessionService.js';
import { SessionStore } from '../src/store/sessionStore.js';

const dataDir = path.join(os.tmpdir(), `clarifyai-smoke-${Date.now()}`);

function check(label: string, condition: boolean, detail = ''): void {
  const mark = condition ? 'PASS' : 'FAIL';
  process.stdout.write(`[${mark}] ${label}${detail ? ` — ${detail}` : ''}\n`);
  if (!condition) process.exitCode = 1;
}

async function main(): Promise<void> {
  const store = new SessionStore(dataDir);
  await store.init();

  const broker = new FeedbackBroker();
  const events: string[] = [];

  const service = new SessionService({
    store,
    broker,
    webOrigin: 'http://127.0.0.1:5173',
    emit: (_sessionId, event) => events.push(event),
  });

  /* 1. 主 Agent 开启会话并给出第一层拆解 */
  const started = await service.start({
    projectContext: {
      projectRoot: 'd:/demo',
      projectName: 'Demo',
      techStack: ['Vue3', 'TypeScript'],
      fileTree: '',
      conventions: '',
      relatedPaths: [],
      notes: '',
    },
    rawRequirement: '做一个批量图片尺寸检查工具',
    decomposition: [
      {
        key: 'a1',
        title: '扫描指定目录下的所有图片',
        detail: '',
        kind: 'functional',
        acceptance: ['WHEN 指定目录存在 THEN 列出其中全部图片文件'],
        dependsOnKeys: [],
        userNoteRef: '',
      },
      {
        key: 'a2',
        title: '读取每张图片的宽高',
        detail: '',
        kind: 'functional',
        acceptance: ['WHEN 图片可解析 THEN 返回其宽高像素值'],
        dependsOnKeys: ['a1'],
        userNoteRef: '',
      },
      {
        key: 'a3',
        title: '把结果导出为 CSV 报告',
        detail: '',
        kind: 'assumption',
        acceptance: [],
        dependsOnKeys: ['a2'],
        userNoteRef: '',
      },
    ],
    maxDepth: 3,
    openUi: false,
    interactionMode: 'canvas',
  });

  check('start 返回会话与画布地址', Boolean(started.sessionId) && started.uiUrl.includes(started.sessionId));

  const initial = await store.load(started.sessionId);
  check('画布 = 一条根 + 3 条初稿', initial?.nodes.length === 4, `实际 ${initial?.nodes.length}`);

  const root = initial?.nodes.find((n) => n.parentId === null);
  check('根节点就是需求书标题', Boolean(root) && root!.id === initial?.rootId, `rootId=${initial?.rootId}`);
  check(
    '拆解条目全部挂在根下',
    initial!.nodes.filter((n) => n.parentId === root!.id).length === 3,
    `实际 ${initial!.nodes.filter((n) => n.parentId === root!.id).length}`,
  );
  check(
    '同批次依赖引用被解析成真实 id',
    (() => {
      const a2 = initial?.nodes.find((n) => n.title.includes('读取每张图片'));
      const a1 = initial?.nodes.find((n) => n.title.includes('扫描指定目录'));
      return Boolean(a2 && a1 && a2.dependsOn[0] === a1.id);
    })(),
  );

  /* 2. 主 Agent 阻塞等待（不 await，模拟它正挂在 await 上） */
  const awaiting = service.awaitFeedback(started.sessionId, 0, 15_000);

  /* 3. 用户在画布上：给 a1 写批注、否决 a3 这条 AI 假设 */
  const a1 = initial!.nodes.find((n) => n.title.includes('扫描指定目录'))!;
  const a3 = initial!.nodes.find((n) => n.title.includes('CSV'))!;

  await service.applyCanvasPatch(started.sessionId, {
    upserted: [{ ...a1, userNote: '只关心 jpg，不要 png' }],
    removedIds: [a3.id],
  });

  const afterEdit = await store.load(started.sessionId);
  check('画布编辑后节点数减少', afterEdit?.nodes.length === 3, `实际 ${afterEdit?.nodes.length}`);
  check('画布编辑不推进轮次', afterEdit?.round === 0, `round=${afterEdit?.round}`);

  /* 单根是不变量：画布不接受第二个根，也不允许删掉根 */
  let secondRootError = '';
  try {
    await service.applyCanvasPatch(started.sessionId, {
      upserted: [{ ...a1, id: 'secondroot001', parentId: null, title: '第二个根' }],
      removedIds: [],
    });
  } catch (error) {
    secondRootError = error instanceof Error ? error.message : String(error);
  }
  check('画布拒绝第二个根节点', secondRootError.includes('只允许一个根'), secondRootError.slice(0, 60));

  let removeRootError = '';
  try {
    await service.applyCanvasPatch(started.sessionId, { upserted: [], removedIds: [root!.id] });
  } catch (error) {
    removeRootError = error instanceof Error ? error.message : String(error);
  }
  check('根节点不可删除', removeRootError.includes('不能删除'), removeRootError.slice(0, 60));

  /* 4. 用户提交 */
  await service.submitCanvasFeedback(started.sessionId, {
    action: 'need-more',
    userFreeText: '另外要支持递归子目录',
    expandRequests: [a1.id],
  });

  const result = await awaiting;

  check('阻塞中的主 Agent 被唤醒', result.status === 'feedback', `status=${result.status}`);
  check('round 游标推进到 1', result.round === 1, `round=${result.round}`);
  check('hint 指出了用户要求的展开目标', result.hint.includes('展开'), result.hint);
  check('hint 转述了用户的自由补充', result.hint.includes('递归子目录'));
  check(
    '被否决的假设不再计入待裁决',
    result.feedback?.pendingAssumptions.length === 0,
    `剩下 ${result.feedback?.pendingAssumptions.length}`,
  );
  check(
    'AI 初稿纠偏率被计算出来',
    typeof result.feedback?.aiDraftCorrectionRate === 'number' && result.feedback.aiDraftCorrectionRate > 0,
    `rate=${result.feedback?.aiDraftCorrectionRate}`,
  );
  check('diff 记录了删除与修改', (result.feedback?.diff.length ?? 0) >= 2, `diff=${result.feedback?.diff.length}`);

  /* 5. 主 Agent 回应批注并继续拆解 */
  const submitted = await service.submitDecomposition({
    sessionId: started.sessionId,
    parentId: a1.id,
    items: [
      {
        key: 'b1',
        title: '递归遍历子目录',
        detail: '',
        kind: 'functional',
        acceptance: ['WHEN 开启递归 THEN 子目录中的图片也被列出'],
        dependsOnKeys: [],
        userNoteRef: '',
      },
    ],
    agentNote: '按你的批注，只保留 jpg 并支持递归',
    replies: [{ nodeId: a1.id, reply: '已改为只处理 jpg 文件' }],
  });

  check('子需求已创建', submitted.created.length === 1);
  check('新条目父节点正确', submitted.created[0]?.parentId === a1.id);
  check('新条目层级加深', submitted.created[0]?.depth === 2, `depth=${submitted.created[0]?.depth}`);

  const afterSubmit = await store.load(started.sessionId);
  check('提交后状态交回用户可编辑', afterSubmit?.status === 'awaiting-user', `status=${afterSubmit?.status}`);
  check(
    'AI 的回应被写回节点',
    Boolean(afterSubmit?.nodes.find((n) => n.id === a1.id)?.detail.includes('已改为只处理 jpg')),
  );

  /* 5.5 补全建议：灰字不落地，用户采纳才写进需求树 */
  const beforeSuggest = (await store.load(started.sessionId))!;
  const suggested = await service.suggest({
    sessionId: started.sessionId,
    items: [
      {
        nodeId: a1.id,
        action: 'refine',
        title: '',
        detail: '',
        acceptance: ['WHEN 目录里只有 png THEN 直接跳过'],
        note: '补一条验收标准',
      },
      {
        nodeId: a1.id,
        action: 'expand',
        title: '按扩展名过滤',
        detail: '',
        acceptance: [],
        note: '',
      },
    ],
  });

  check(
    '建议创建为 pending',
    suggested.created.length === 2 && suggested.created.every((s) => s.status === 'pending'),
  );

  const afterSuggest = (await store.load(started.sessionId))!;
  check(
    '建议不直接写入需求树',
    afterSuggest.nodes.length === beforeSuggest.nodes.length,
    `${beforeSuggest.nodes.length} → ${afterSuggest.nodes.length}`,
  );

  await service.resolveSuggestion(started.sessionId, suggested.created[0]!.id, true);
  const afterAcceptRefine = (await store.load(started.sessionId))!;
  check(
    '采纳 refine 后验收标准落地',
    Boolean(
      afterAcceptRefine.nodes
        .find((n) => n.id === a1.id)
        ?.acceptance.includes('WHEN 目录里只有 png THEN 直接跳过'),
    ),
  );

  await service.resolveSuggestion(started.sessionId, suggested.created[1]!.id, true);
  const afterAcceptExpand = (await store.load(started.sessionId))!;
  const newChild = afterAcceptExpand.nodes.find((n) => n.title === '按扩展名过滤');
  check('采纳 expand 后新增子节点', Boolean(newChild) && newChild!.parentId === a1.id);

  /* 5.6 结构性建议：move 换父节点、remove 删冗余 */
  const movedSuggestion = await service.suggest({
    sessionId: started.sessionId,
    items: [
      {
        nodeId: newChild!.id,
        action: 'move',
        title: '',
        detail: '',
        acceptance: [],
        targetParentId: root!.id,
        position: 0,
        note: '这条更像顶层流程',
      },
    ],
  });
  await service.resolveSuggestion(started.sessionId, movedSuggestion.created[0]!.id, true);

  const afterMove = (await store.load(started.sessionId))!;
  const movedNode = afterMove.nodes.find((n) => n.title === '按扩展名过滤');
  check('采纳 move 后父节点改变', movedNode?.parentId === root!.id, `parentId=${movedNode?.parentId}`);
  check('采纳 move 后层级重算', movedNode?.depth === 1, `depth=${movedNode?.depth}`);

  const beforeRemoveCount = afterMove.nodes.length;
  const removeSuggestion = await service.suggest({
    sessionId: started.sessionId,
    items: [
      {
        nodeId: movedNode!.id,
        action: 'remove',
        title: '',
        detail: '',
        acceptance: [],
        note: '与现有条目重复',
      },
    ],
  });
  const removeResult = await service.resolveSuggestion(
    started.sessionId,
    removeSuggestion.created[0]!.id,
    true,
  );

  const afterRemoveNode = (await store.load(started.sessionId))!;
  check(
    '采纳 remove 后节点被删除',
    afterRemoveNode.nodes.length === beforeRemoveCount - 1,
    `${beforeRemoveCount} → ${afterRemoveNode.nodes.length}`,
  );
  check('采纳 remove 后返回被删 id', removeResult.removedIds.includes(movedNode!.id));

  let missingSuggestionError = '';
  try {
    await service.resolveSuggestion(started.sessionId, 'no-such-suggestion', true);
  } catch (error) {
    missingSuggestionError = error instanceof Error ? error.message : String(error);
  }
  check(
    '不存在的建议被拒绝',
    missingSuggestionError.includes('建议不存在'),
    missingSuggestionError.slice(0, 40),
  );

  const a2 = (await store.load(started.sessionId))!.nodes.find((n) =>
    n.title.includes('读取每张图片'),
  )!;
  const batch = await service.suggest({
    sessionId: started.sessionId,
    items: [a1.id, a2.id, root!.id, submitted.created[0]!.id].map((nodeId, index) => ({
      nodeId,
      action: 'refine' as const,
      title: `建议标题 ${index}`,
      detail: '',
      acceptance: [],
      note: '批量建议',
    })),
  });
  check('条数不再按场景硬卡', batch.created.length === 4, `实际 ${batch.created.length}`);

  /* 6. 用户确认全部并收口 */
  const all = afterSubmit!;
  await service.applyCanvasPatch(started.sessionId, {
    upserted: all.nodes.map((n) => ({ ...n, status: 'confirmed' as const })),
    removedIds: [],
  });
  await service.submitCanvasFeedback(started.sessionId, { action: 'confirmed' });

  const validate = await service.validate(started.sessionId);
  check('体检无 error 级问题', validate.ok, JSON.stringify(validate.issues.filter((i) => i.level === 'error')));
  check('无待裁决假设', validate.stats.draftAssumptions === 0, `剩下 ${validate.stats.draftAssumptions}`);

  /* 7. 硬闸门：用户只点了「确认本轮」，AI 不得自行新增节点 */
  const beforeGate = (await store.load(started.sessionId))!;
  let gateError = '';
  try {
    await service.submitDecomposition({
      sessionId: started.sessionId,
      parentId: a1.id,
      items: [
        {
          key: 'c1',
          title: 'AI 自作主张新增的节点',
          detail: '',
          kind: 'functional',
          acceptance: ['WHEN 用户没点按钮 THEN 这条不该存在'],
          dependsOnKeys: [],
          userNoteRef: '',
        },
      ],
      agentNote: '',
      replies: [],
    });
  } catch (error) {
    gateError = error instanceof Error ? error.message : String(error);
  }
  const afterGate = (await store.load(started.sessionId))!;
  check('未点按钮时 AI 新增被拒绝', gateError.includes('已被拒绝'), gateError.slice(0, 80));
  check(
    '被拒绝的新增一个节点都没落盘',
    afterGate.nodes.length === beforeGate.nodes.length,
    `${beforeGate.nodes.length} → ${afterGate.nodes.length}`,
  );

  /* 8. 只回应批注（items 传空）不受闸门影响 */
  const replied = await service.submitDecomposition({
    sessionId: started.sessionId,
    parentId: a1.id,
    items: [],
    agentNote: '',
    replies: [{ nodeId: a1.id, reply: '确认不再新增任何节点' }],
  });
  const afterReply = (await store.load(started.sessionId))!;
  check('items 为空时不新增节点', replied.created.length === 0);
  check(
    '只回应的批注仍被写回节点',
    Boolean(afterReply.nodes.find((n) => n.id === a1.id)?.detail.includes('确认不再新增任何节点')),
  );

  /* 9. await 必须被封顶：请求再久也不能撞上宿主的工具调用硬超时 */
  const cappedService = new SessionService({
    store,
    broker: new FeedbackBroker(),
    webOrigin: 'http://127.0.0.1:5173',
    maxBlockMs: 1_200,
  });
  const capStartedAt = Date.now();
  const capped = await cappedService.awaitFeedback(started.sessionId, afterReply.round, 300_000);
  const capElapsed = Date.now() - capStartedAt;
  check(
    '请求 300s 也被封顶（提前返回 pending，而不是被宿主掐断）',
    capped.status === 'pending' && capElapsed < 5_000,
    `status=${capped.status} 实际阻塞 ${capElapsed}ms`,
  );

  const finalized = await service.finalize({
    sessionId: started.sessionId,
    implementationPlan: '先扫描目录，再逐个读取尺寸，最后输出报告。',
  });

  check('规格生成了 Markdown', finalized.spec.markdown.includes('# 需求规格'));
  check('规格只包含已确认条目', finalized.spec.nodes.length === all.nodes.length);
  check('规格包含实现路径', finalized.spec.markdown.includes('先扫描目录'));

  const closed = await store.load(started.sessionId);
  check(
    '生成规格后会话仍可继续编辑',
    closed?.status === 'awaiting-user',
    `status=${closed?.status}`,
  );

  /* 9. 历史会话可被找回、可被删除 */
  const list = await store.list();
  check('历史会话可列出', list.length === 1);

  const removed = await store.remove(started.sessionId);
  const afterRemove = await store.list();
  check('会话可被删除', removed && afterRemove.length === 0, `剩余 ${afterRemove.length}`);
  check('重复删除返回 false（幂等）', (await store.remove(started.sessionId)) === false);

  process.stdout.write(`\n--- 规格预览 ---\n${finalized.spec.markdown.slice(0, 700)}\n`);

  await fs.rm(dataDir, { recursive: true, force: true });
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exit(1);
});
