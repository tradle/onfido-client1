
const { EventEmitter } = require('events')
const typeforce = require('typeforce')
const debug = require('debug')('tradle:onfido')
const sublevel = require('level-sublevel')
const secondary = require('level-secondary')
const Promise = require('bluebird')
const co = Promise.coroutine
const collect = Promise.promisify(require('stream-collector'))
const OnfidoTypes = require('@tradle/onfido-api/lib/types')
// const convert = require('./convert')
const { extend, omit, shallowClone, clone } = require('./utils')
const DB_OPTS = { valueEncoding: 'json' }
const DEV = process.env.NODE_ENV !== 'production'
function identityCheckType (variant) {
  return variant === 'kyc' || variant === 'standard'
}

const addressType = typeforce.compile({
  flat_number: typeforce.maybe(typeforce.String),
  building_number: typeforce.oneOf(typeforce.Number, typeforce.String),
  street: typeforce.String,
  sub_street: typeforce.maybe(typeforce.String),
  town: typeforce.String,
  postcode: typeforce.String,
  country: str => typeof str === 'string' && str.length === 3
})

const types = {
  address: addressType,
  applicantProps: typeforce.compile({
    first_name: typeforce.String,
    last_name: typeforce.String,
    email: typeforce.maybe(typeforce.String),
    gender: typeforce.maybe(typeforce.String),
    addresses: typeforce.maybe(typeforce.arrayOf(addressType))
  }),
  document: typeforce.compile({
    link: typeforce.String,
    type: OnfidoTypes.docType,
    file: typeforce.Buffer,
    filename: typeforce.String,
    side: typeforce.maybe(typeforce.String)
  }),
  photo: typeforce.compile({
    link: typeforce.String,
    file: typeforce.Buffer,
    filename: typeforce.String
  })
}

module.exports = createClient

function createClient (opts) {
  typeforce({
    api: typeforce.Object,
    db: typeforce.Object
  }, opts)

  let { api, db } = opts
  db = Promise.promisifyAll(sublevel(db))

  const applicants = Promise.promisifyAll(db.sublevel('a', DB_OPTS))
  const webhooks = Promise.promisifyAll(db.sublevel('w', DB_OPTS))
  const pendingChecks = Promise.promisifyAll(db.sublevel('c', DB_OPTS))
  const completeChecks = Promise.promisifyAll(db.sublevel('cc', DB_OPTS))

  pendingChecks.id = secondary(pendingChecks, 'id', function (check) {
    return check.onfido.id
  })

  pendingChecks.id = Promise.promisifyAll(pendingChecks.id)

  const createApplicant = co(function* (opts) {
    typeforce({
      applicant: typeforce.String,
      props: types.applicantProps,
      tradle: typeforce.maybe(typeforce.Object)
    }, opts)

    const applicant = {
      permalink: opts.applicant,
      onfido: yield api.applicants.create(opts.props),
      tradle: opts.tradle,
      props: opts.props,
      documents: [],
      photos: [],
      checks: []
    }

    yield applicants.putAsync(opts.applicant, applicant)
    debug('created applicant', opts.applicant)
    return applicant
  })

  const updateApplicant = co(function* (opts) {
    typeforce({
      applicant: typeforce.String,
      props: typeforce.Object,
      tradle: typeforce.maybe(typeforce.Object)
    }, opts)

    const current = yield applicants.getAsync(opts.applicant)
    const oApplicant = yield api.applicants.update(current.onfido.id, opts.props)
    yield applicants.putAsync(opts.applicant, {
      onfido: oApplicant,
      props: extend(current.props, opts.props),
      tradle: extend(current.tradle || {}, opts.tradle || {})
    })
  })

  const listApplicants = co(function* () {
    return collect(applicants.createValueStream())
  })

  const uploadDocument = co(function* (opts) {
    typeforce({
      applicant: typeforce.String,
      document: types.document
    }, opts)

    yield ensureNoPendingCheck(opts.applicant)

    const applicant = yield applicants.getAsync(opts.applicant)
    const doc = yield api.applicants.uploadDocument(applicant.onfido.id, omit(opts.document, ['link']))
    applicant.documents.push({
      tradle: opts.document.link,
      onfido: doc
    })

    debug('uploaded document for', opts.applicant)
    yield applicants.putAsync(opts.applicant, applicant)
  })

  const uploadLivePhoto = co(function* (opts) {
    typeforce({
      applicant: typeforce.String,
      photo: types.photo
    }, opts)

    yield ensureNoPendingCheck(opts.applicant)

    const applicant = yield applicants.getAsync(opts.applicant)
    const photo = yield api.applicants.uploadLivePhoto(applicant.onfido.id, omit(opts.photo, ['link']))
    applicant.photos.push({
      tradle: opts.photo.link,
      onfido: photo
    })

    debug('uploaded photo for', opts.applicant)
    yield applicants.putAsync(opts.applicant, applicant)
  })

  const ensureNoPendingCheck = co(function* (applicant) {
    try {
      yield pendingChecks.getAsync(applicant)
    } catch (err) {
      return
    }

    throw new Error('wait till the current check is resolved')
  })

  const createCheck = co(function* (opts) {
    typeforce({
      applicant: typeforce.String,
      checkDocument: typeforce.maybe(typeforce.Boolean),
      checkFace: typeforce.maybe(typeforce.Boolean),
      checkIdentity: typeforce.maybe(identityCheckType),
      result: typeforce.maybe(typeforce.String)
    }, opts)

    const permalink = opts.applicant
    const { checkDocument, checkFace, checkIdentity } = opts
    if (!checkDocument && !checkFace && !checkIdentity) {
      throw new Error('expected "checkDocument" (and/or) "checkFace" (and/or) "checkIdentity')
    }

    yield ensureNoPendingCheck(permalink)

    const applicant = yield applicants.getAsync(permalink)
    const reports = []
    if (checkDocument) {
      if (!applicant.documents.length) {
        throw new Error('upload document before creating a check')
      }

      reports.push({ name: 'document' })
    }

    if (checkFace) {
      if (!applicant.photos.length) {
        throw new Error('upload a photo before creating a check')
      }

      reports.push({ name: 'facial_similarity' })
    }

    if (checkIdentity) {
      const { date_of_birth, addresses } = applicant.props
      if (!(date_of_birth && addresses && addresses.length)) {
        throw new Error('address is required for identity check')
      }

      reports.push({
        name: 'identity',
        variant: checkIdentity
      })
    }

    const applicantId = applicant.onfido.id
    const check = {
      onfido: yield api.checks.create(applicantId, { reports }),
      applicant: permalink,
      applicantId: applicantId,
      checkFace,
      checkDocument,
      checkIdentity
    }

    debug('created check for', permalink)
    if (DEV && opts.result) {
      check.onfido.result = opts.result
      check.onfido.reports.forEach(r => r.result = opts.result)
    }

    if (applicant.documents.length) {
      check.latestDocument = last(applicant.documents).tradle
    }

    if (applicant.photos.length) {
      check.latestPhoto = last(applicant.photos).tradle
    }

    yield processCheck({ update: check })
    // yield applicants.putAsync(opts.applicant, applicant)
  })

  const updatePendingCheck = co(function* (opts) {
    typeforce({
      applicant: typeforce.maybe(typeforce.String),
      check: typeforce.maybe(typeforce.Object)
    }, opts)

    let { applicant, check } = opts
    if (!check) {
      if (!applicant) throw new Error('expected "applicant" or "check"')
      check = yield getPendingCheck(applicant)
    }

    const currentStatus = check.status
    const current = clone(check)
    check.onfido = yield api.checks.get({
      applicantId: check.applicantId,
      checkId: check.onfido.id,
      expandReports: true
    })

    debug('updated check for', check.applicant)
    return yield processCheck({
      current,
      update: check
    })
  })

  const processCheck = co(function* ({ current, update }) {
    const check = update
    const { result, status } = check.onfido
    check.status = status
    check.result = result
    const permalink = check.applicant
    const applicant = yield applicants.getAsync(permalink)
    const ret = { applicant, check }
    if (status.indexOf('complete') !== 0) {
      yield pendingChecks.putAsync(permalink, check)
    } else {
      yield completeChecks.putAsync(check.onfido.id, check)

      applicant.checks.push(check)
      yield Promise.all([
        applicants.putAsync(permalink, applicant),
        pendingChecks.delAsync(permalink)
      ])

      debug(`check for ${permalink} completed with result: ${result}`)

      ee.emit('check', ret)
      // allow subscribing to 'check:consider', 'check:complete'
      ee.emit('check:' + result, ret)
    }

    emitCompletedReports({ applicant, current, update })
    return ret
  })

  function emitCompletedReports ({ applicant, current, update }) {
    const reports = getCompletedReports({ current, update })
    reports.forEach(report => {
      ee.emit('report:complete', { applicant, report, check: update })
    })
  }

  const getPendingCheck = applicant => pendingChecks.getAsync(applicant)
  const getApplicant = applicant => applicants.getAsync(applicant)
  const getPendingCheckById = id => pendingChecks.id.getAsync(id)

  const processEvent = co(function* processEvent (req, res, desiredResult) {
    const url = 'https://' + req.get('host') + req.originalUrl
    let webhook
    try {
      webhook = yield webhooks.getAsync(url)
    } catch (err) {
      throw new Error('webhook not found for url: ' + url)
    }

    let event
    try {
      event = yield api.webhooks.handleEvent(req, webhook.token)
    } catch (err) {
      debug(err)
      return res.status(500).end()
    }

    const { resource_type, action, object } = event
    if (DEV && desiredResult) object.result = desiredResult

    if (!/\.completed?$/.test(action)) {
      return res.status(200).end()
    }

    let checkId
    if (resource_type === 'report') {
      checkId = parseReportURL(object.href).checkId
    } else if (resource_type === 'check') {
      checkId = object.id
    } else {
      debug('unknown resource_type: ' + resource_type)
      return res.status(404).end()
    }

    try {
      const complete = yield completeChecks.getAsync(checkId)
      return res.status(200).end()
    } catch (err) {
    }

    let current
    try {
      current = yield getPendingCheckById(checkId)
    } catch (err) {
      debug(err)
      return res.status(err.notFound ? 404 : 500).end()
    }

    let update
    let applicant
    try {
      const result = yield updatePendingCheck({ check: clone(current) })
      update = result.check
      applicant = result.applicant
    } catch (err) {
      debug(err)
      return res.status(500).end()
    }

    emitCompletedReports({ applicant, current, update })
    res.status(200).end()
  })

  const registerWebhook = co(function* ({ url, events }) {
    let existing
    try {
      existing = yield webhooks.getAsync(url)
    } catch (err) {}

    if (existing) throw new Error('webhook already registered')

    const webhook = yield api.webhooks.register({ url, events })
    yield webhooks.putAsync(webhook.url, webhook)
    return webhook
  })

  const unregisterWebhook = co(function* (url) {
    const existing = yield webhooks.getAsync(url)
    if (!existing) throw new Error('webhook not found')

    const webhook = yield api.webhooks.unregister(url)
    yield webhooks.delAsync(webhook.url)
    return webhook
  })

  const listWebhooks = co(function* () {
    const saved = yield collect(webhooks.createReadStream())
    return saved.map(({ key, value }) => {
      return extend({ url: key }, value)
    })
  })

  const getOnfidoResource = co(function* (id) {
    return db.getOnfidoResource(id)
  })

  let pendingChecksStream
  const close = co(function* () {
    pendingChecksStream.destroy()
    yield db.closeAsync()
  })

  const ee = new EventEmitter()
  const start = co(function* () {
    pendingChecksStream = pendingChecks.createValueStream()
      .on('data', pending => {
        updatePendingCheck({ applicant: pending.applicant })
      })
      .on('error', err => ee.emit('error', err))
  })

  start()

  const client = extend(ee, {
    applicants: {
      list: listApplicants,
      get: getApplicant,
      create: createApplicant,
      update: updateApplicant
    },
    checks: {
      create: createCheck,
      pending: getPendingCheck
    },
    webhooks: {
      register: registerWebhook,
      unregister: unregisterWebhook,
      list: listWebhooks,
      get: ({ url }) => webhooks.getAsync(url)
    },
    getAddressesForPostcode: api.misc.getAddressesForPostcode,
    uploadDocument,
    uploadLivePhoto,
    processEvent,
    close
  })

  return client
}

function last (arr) {
  return arr.length ? arr[arr.length - 1] : undefined
}

function parseReportURL (url) {
  const [match, checkId, reportId] = url.match(/checks\/([a-zA-Z0-9-_]+)\/reports\/([a-zA-Z0-9-_]+)/)
  return { checkId, reportId }
}

function getCompletedReports ({ current, update }) {
  if (update.onfido) update = update.onfido
  if (!current) return update.reports.filter(isComplete)

  if (current.onfido) current = current.onfido

  return update.reports.filter(report => {
    if (!isComplete(report)) return

    const match = current.reports.find(r => r.id === report.id)
    if (match) return !isComplete(match)
  })
}

function isComplete (onfidoObject) {
  return (onfidoObject.status || '').indexOf('complete') !== -1
}
