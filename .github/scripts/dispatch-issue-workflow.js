function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export function readIssueFormSection(body, heading) {
  const normalized = String(body ?? '').replace(/\r\n/g, '\n')
  const pattern = new RegExp(
    `(?:^|\\n)###\\s+${escapeRegex(heading)}\\s*\\n+([\\s\\S]*?)(?=\\n###\\s+|$)`,
    'i',
  )
  return pattern.exec(normalized)?.[1]?.trim() ?? ''
}

function parseBooleanOption(value) {
  return /^\s*true\b/i.test(value) ? 'true' : 'false'
}

function formatSummary(summary) {
  if (summary.length === 0)
    return '无额外输入.'

  return summary.map(([key, value]) => `- \`${key}\`: ${value}`).join('\n')
}

export function resolveDispatchRequest(issue) {
  const title = String(issue?.title ?? '')
  const body = String(issue?.body ?? '')
  const target = readIssueFormSection(body, '触发目标 target')

  if (title.startsWith('[DailySync]') || target.includes('Daily Sync & Build')) {
    const force = parseBooleanOption(readIssueFormSection(body, '强制同步 force'))
    const skipGt5u = parseBooleanOption(readIssueFormSection(body, '跳过 GT5U skip_gt5u'))

    return {
      workflowId: 'daily.yml',
      workflowName: 'Daily Sync & Build',
      inputs: {
        force,
        skip_gt5u: skipGt5u,
      },
      summary: [
        ['force', force],
        ['skip_gt5u', skipGt5u],
      ],
    }
  }

  if (title.startsWith('[Export]') || target.includes('Export PT Lang Package')) {
    const sourceProject = readIssueFormSection(body, '数据来源 source_project')
    const releaseTarget = readIssueFormSection(body, '发布目标 release_target')

    return {
      workflowId: 'export-pt-lang-package.yml',
      workflowName: 'Export PT Lang Package',
      inputs: {},
      summary: [
        ['source_project', sourceProject || 'PT 18818 - Daily 项目当前全部 lang 文件'],
        ['release_target', releaseTarget || 'latest - 覆盖 pt-lang-package-latest Release 和 pt-lang-package.zip'],
      ],
    }
  }

  return undefined
}

export async function dispatchIssueWorkflow({ github, context, core }) {
  const issue = context.payload.issue
  const request = resolveDispatchRequest(issue)

  if (!request) {
    core.info('No issue workflow dispatch target matched.')
    return
  }

  const owner = context.repo.owner
  const repo = context.repo.repo
  const issueNumber = issue.number
  const ref = context.payload.repository?.default_branch ?? 'master'
  const workflowUrl = `https://github.com/${owner}/${repo}/actions/workflows/${request.workflowId}`

  await github.rest.actions.createWorkflowDispatch({
    owner,
    repo,
    workflow_id: request.workflowId,
    ref,
    inputs: request.inputs,
  })

  await github.rest.issues.createComment({
    owner,
    repo,
    issue_number: issueNumber,
    body: [
      `已触发 \`${request.workflowName}\`.`,
      '',
      '选项:',
      formatSummary(request.summary),
      '',
      `运行页: ${workflowUrl}`,
    ].join('\n'),
  })

  await github.rest.issues.update({
    owner,
    repo,
    issue_number: issueNumber,
    state: 'closed',
    state_reason: 'completed',
  })
}
