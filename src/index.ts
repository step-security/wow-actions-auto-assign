import fs from 'fs'
import * as core from '@actions/core'
import * as github from '@actions/github'
import axios, { isAxiosError } from 'axios'
import * as util from './util.js'
import { getInputs } from './inputs.js'

async function validateSubscription() {
  const eventPath = process.env.GITHUB_EVENT_PATH
  let repoPrivate: boolean | undefined

  if (eventPath && fs.existsSync(eventPath)) {
    const eventData = JSON.parse(fs.readFileSync(eventPath, 'utf8'))
    repoPrivate = eventData?.repository?.private
  }

  const upstream = 'wow-actions/auto-assign'
  const action = process.env.GITHUB_ACTION_REPOSITORY
  const docsUrl =
    'https://docs.stepsecurity.io/actions/stepsecurity-maintained-actions'

  core.info('')
  core.info('\u001b[1;36mStepSecurity Maintained Action\u001b[0m')
  core.info(`Secure drop-in replacement for ${upstream}`)
  if (repoPrivate === false)
    core.info('\u001b[32m\u2713 Free for public repositories\u001b[0m')
  core.info(`\u001b[36mLearn more:\u001b[0m ${docsUrl}`)
  core.info('')

  if (repoPrivate === false) return

  const serverUrl = process.env.GITHUB_SERVER_URL || 'https://github.com'
  const body: Record<string, string> = { action: action || '' }
  if (serverUrl !== 'https://github.com') body.ghes_server = serverUrl
  try {
    await axios.post(
      `https://agent.api.stepsecurity.io/v1/github/${process.env.GITHUB_REPOSITORY}/actions/maintained-actions-subscription`,
      body,
      { timeout: 3000 },
    )
  } catch (error) {
    if (isAxiosError(error) && error.response?.status === 403) {
      core.error(
        `\u001b[1;31mThis action requires a StepSecurity subscription for private repositories.\u001b[0m`,
      )
      core.error(
        `\u001b[31mLearn how to enable a subscription: ${docsUrl}\u001b[0m`,
      )
      process.exit(1)
    }
    core.info('Timeout or API not reachable. Continuing to next step.')
  }
}

async function run() {
  try {
    await validateSubscription()
    const { context } = github

    core.debug(`event: ${context.eventName}`)
    core.debug(`action: ${context.payload.action}`)

    const pr = context.payload.pull_request
    const issue = context.payload.issue
    const payload = pr || issue
    const actions = ['opened', 'edited', 'labeled', 'unlabeled']
    if (
      payload &&
      (util.isValidEvent('issues', actions) ||
        util.isValidEvent('pull_request', actions) ||
        util.isValidEvent('pull_request_target', actions))
    ) {
      const inputs = getInputs()
      core.debug(`inputs: \n${JSON.stringify(inputs, null, 2)}`)

      if (pr && pr.draft && inputs.skipDraft !== false) {
        return util.skip('is draft')
      }

      if (
        inputs.skipKeywords &&
        util.hasSkipKeywords(payload.title, inputs.skipKeywords)
      ) {
        return util.skip('title includes skip-keywords')
      }

      const octokit = util.getOctokit()
      const checkIncludings =
        inputs.includeLabels && inputs.includeLabels.length > 0
      const checkExcludings =
        inputs.excludeLabels && inputs.excludeLabels.length > 0
      if (checkIncludings || checkExcludings) {
        const labels = await util.getIssueLabels(octokit, payload.number)
        const hasAny = (arr: string[]) => labels.some((l) => arr.includes(l))

        if (checkIncludings) {
          const any = hasAny(inputs.includeLabels)
          if (!any) {
            return util.skip(`is not labeled with any of the "includeLabels"`)
          }
        }

        if (checkExcludings) {
          const any = hasAny(inputs.excludeLabels)
          if (any) {
            return util.skip(`is labeled with one of the "excludeLabels"`)
          }
        }
      }

      const { assignees, teams, reviewers } = await util.getState(octokit)
      if (teams.length || reviewers.length) {
        const s = (len: number) => (len > 1 ? 's' : '')
        const logTeams = `team_reviewer${s(teams.length)} "${teams.join(', ')}"`
        const logReviewers = `reviewer${s(reviewers.length)} "${reviewers.join(
          ', ',
        )}"`

        if (teams.length && reviewers.length) {
          util.skip(`has requested ${logReviewers} and ${logTeams}`)
        } else if (teams.length) {
          util.skip(`has requested ${logTeams}`)
        } else {
          util.skip(`has requested ${logReviewers}`)
        }
      } else {
        await util.addReviewers(octokit, inputs)
      }

      if (assignees.length) {
        util.skip(`has assigned to ${assignees.join(', ')}`)
      } else {
        await util.addAssignees(octokit, inputs)
      }
    }
  } catch (e) {
    core.error(e)
    core.setFailed(e.message)
  }
}

run()
