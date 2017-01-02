
const Promise = require('bluebird')
const co = Promise.coroutine
const test = require('tape')
const parseDataUri = require('parse-data-uri')
const PassThrough = require('readable-stream').PassThrough
const { utils } = require('@tradle/engine')
const { omit } = utils
const createOnfido = require('../')
const convert = require('../convert')
const mock = require('./mock')
const fixtures = {
  applicants: require('./fixtures/applicants'),
  checks: require('./fixtures/checks'),
  documents: require('./fixtures/documents'),
  documentImages: require('./fixtures/document-images'),
  tradle: require('./fixtures/tradle')
}

test('convert', function (t) {
  const pi = fixtures.tradle['tradle.PersonalInfo']
  const applicant = convert.toOnfido(pi)
  t.same(applicant, {
    first_name: pi.firstName,
    last_name: pi.lastName,
    email: pi.emailAddress,
    gender: pi.sex.title
  })

  const license = fixtures.tradle['tradle.DrivingLicense']
  const olicense = convert.toOnfido(license)
  t.same(omit(olicense, 'filename'), {
    file: parseDataUri(license.photos[0].url).data,
    // filename: 'license.jpg',
    type: 'driving_license'
  })

  t.throws(() => convert.toTradle({ document_type: 'booglie' }))
  t.throws(() => convert.toOnfido({ [TYPE]: 'tradle.SomeType' }))
  t.end()
})

test('create applicant', co(function* (t) {
  const applicant = fixtures.applicants[0]
  const applicantId = applicant.id
  const onfido = mock.client({ applicants: [applicant] })
  const permalink = 'joe'
  const personalInfo = fixtures.tradle['tradle.PersonalInfo']
  yield onfido.applicants.create({
    applicant: permalink,
    personalInfo
  })

  const applicants = yield onfido.applicants.list()
  t.equal(applicants.length, 1)
  t.same(applicants[0], {
    permalink: permalink,
    onfido: applicant,
    personalInfo: personalInfo,
    documents: [],
    photos: [],
    checks: []
  })

  t.end()
}))

test('basic', co(function* (t) {
  const result = 'clear'
  const applicant = fixtures.applicants[0]
  const applicantId = applicant.id
  const check = adjustCheck(fixtures.checks[applicantId][1], { status: 'in_progress' })
  const document = fixtures.documents[applicantId][0]
  const pendingReport = check.reports[0]
  const completeCheck = adjustCheck(check, { status: 'complete', result })
  const onfido = mock.client({
    applicants: [applicant],
    checks: [check, completeCheck],
    documents: [document]
  })

  const permalink = 'joe'
  const personalInfo = fixtures.tradle['tradle.PersonalInfo']
  yield onfido.applicants.create({
    applicant: permalink,
    personalInfo
  })

  try {
    yield onfido.checks.create({ applicant: permalink })
    t.fail('should not be able to create check before uploading a document')
  } catch (err) {
    t.ok(/upload document/.test(err.message))
  }

  const license = fixtures.tradle['tradle.DrivingLicense']
  const photo = fixtures.tradle['tradle.Selfie']
  yield onfido.uploadDocument({
    applicant: permalink,
    document: license
  })

  try {
    yield onfido.checks.create({
      applicant: permalink,
      checkFace: true
    })

    t.fail('should not be able to create a face check before uploading a document')
  } catch (err) {
    t.ok(/upload a photo/.test(err.message))
  }

  yield onfido.uploadLivePhoto({
    applicant: permalink,
    photo: photo
  })

  yield onfido.checks.create({
    applicant: permalink,
    checkFace: true
  })

  const pending = yield onfido.checks.pending(permalink)
  t.same(pending, {
    applicant: permalink,
    applicantId: applicantId,
    onfido: check,
    document: utils.hexLink(license),
    photo: utils.hexLink(photo)
  })

  const webhookReq = new PassThrough()
  webhookReq.write(JSON.stringify({
    payload: {
      resource_type: 'check',
      action: 'check.completed',
      object: {
        id: check.id,
        status: 'completed',
        completed_at: new Date().toJSON(), // for correct format
        href: check.href,
        reports: completeCheck.reports
      }
    }
  }))

  webhookReq.end()

  const webhookRes = {
    status: function (code) {
      t.equal(code, 200)
      return webhookRes
    },
    end: function () {
      // t.pass()
    }
  }

  const awaitEvent = new Promise(resolve => onfido.on('check:' + result, resolve))

  yield onfido.processEvent(webhookReq, webhookRes)
  try {
    yield onfido.checks.pending(permalink)
    t.fail('should not have pending check')
  } catch (err) {}

  yield awaitEvent

  t.end()
}))

function adjustCheck (obj, props) {
  const copy = utils.clone(obj, props)
  if (copy.reports) {
    copy.reports = copy.reports.map(r => {
      return utils.clone(r, props)
    })
  }

  return copy
}
