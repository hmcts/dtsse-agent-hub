# Import coverage

24 DMN files read.

## Entries by kind

| Kind | Entries | Structured | Raw FEEL |
| --- | ---: | ---: | ---: |
| initiation | 767 | 703 | 64 |
| configuration | 872 | 816 | 56 |
| permissions | 400 | 400 | 0 |
| completion | 218 | 218 | 0 |
| cancellation | 114 | 114 | 0 |
| task-types | 172 | 172 | 0 |

## Unrepresentable

None. Every element and attribute that carries behaviour has a place in the spec.

## Presentation not carried

- element ids (regenerated): 6809
- attribute biodi:width: 123
- decision requirements diagram layout (regenerated): 24
- attribute namespace: 24
- attribute exporter: 24
- attribute exporterVersion: 24
- attribute biodi:annotationsWidth: 2

## Notes

None.

## Raw FEEL fallbacks

Represented as `{feel: ...}` because they are outside the structured expression forms.

- initiation input referCaseTo [et_englandwales, et_englandwales_multiple, et_scotland, et_scotland_multiple]: `if(additionalData!=null and additionalData.Data!=null and additionalData.Data.referralCollection!=null and count(additionalData.Data.referra...`
- initiation input referralSubject [et_englandwales, et_englandwales_multiple, et_scotland, et_scotland_multiple]: `if(additionalData!=null and additionalData.Data!=null and additionalData.Data.referralCollection!=null and count(additionalData.Data.referra...`
- initiation input updateReferCaseTo [et_englandwales, et_scotland]: `if(additionalData!=null and additionalData.Data!=null and additionalData.Data.referralCollection!=null and count(additionalData.Data.referra...`
- initiation input directionTo [et_englandwales, et_englandwales_multiple, et_scotland, et_scotland_multiple]: `if(additionalData!=null and additionalData.Data!=null and additionalData.Data.referralCollection!=null and count(additionalData.Data.referra...`
- initiation input et3FormReceived [et_englandwales, et_scotland]: `if(additionalData!=null and additionalData.Data!=null and additionalData.Data.respondentCollection!=null and count(additionalData.Data.respo...`
- initiation input isThereAnEt3Response [et_englandwales, et_scotland]: `if(additionalData!=null and additionalData.Data!=null and additionalData.Data.respondentCollection!=null and count(additionalData.Data.respo...`
- initiation input isECC [et_englandwales, et_scotland]: `if(additionalData!=null and additionalData.Data!=null and additionalData.Data.respondentCollection!=null and count(additionalData.Data.respo...`
- initiation input isECCReplyReceived [et_englandwales, et_scotland]: `if ( additionalData != null and additionalData.Data != null and additionalData.Data.respondentCollection != null and count(additionalData.Da...`
- initiation input respondentECCReply [et_englandwales, et_scotland]: `if(additionalData!=null and additionalData.Data!=null and additionalData.Data.respondentCollection!=null and count(additionalData.Data.respo...`
- initiation input listAHearing [et_englandwales, et_scotland]: `if(additionalData.Data.etICHearingNotListedListUpdated!=null and count(additionalData.Data.etICHearingNotListedListUpdated) > 0 and (list co...`
- initiation input hearingsHeard [et_englandwales, et_scotland]: `additionalData!=null and additionalData.Data!=null and additionalData.Data.hearingDetailsCollection!=null and count(additionalData.Data.hear...`
- initiation input submissionReasonApplication [et_englandwales, et_scotland]: `if(additionalData!=null and additionalData.Data!=null and additionalData.Data.genericTseApplicationCollection!=null and count(additionalData...`
- initiation input applicationResponseFrom [et_englandwales, et_scotland]: `if(additionalData!=null and additionalData.Data!=null and additionalData.Data.genericTseApplicationCollection!=null and count(additionalData...`
- initiation input responseToApplicationType [et_englandwales, et_scotland]: `if(additionalData!=null and additionalData.Data!=null and additionalData.Data.genericTseApplicationCollection!=null and count(additionalData...`
- initiation helper LATEST_APPLICATION_TYPE [et_englandwales]: `if(additionalData!=null and additionalData.Data!=null and additionalData.Data.genericTseApplicationCollection!=null and count(additionalData...`
- initiation helper LATEST_APPLICATION_TYPE [et_scotland]: `if(additionalData!=null and additionalData.Data!=null and additionalData.Data.genericTseApplicationCollection!=null and count(additionalData...`
- initiation helper LATEST_APPLICATION_RESPOND_TYPE [et_englandwales, et_scotland]: `if(additionalData!=null and additionalData.Data!=null and additionalData.Data.genericTseApplicationCollection!=null and count(additionalData...`
- initiation helper LATEST_NOTIFICATION_RESPONSE_IS_ECC_FROM_CLAIMANT [et_englandwales, et_scotland]: `(LATEST_NOTIFICATION_RESPONSE_IS_ECC and LATEST_NOTIFICATION_RESPONSE_IS_FROM_CLAIMANT)`
- initiation helper LATEST_NOTIFICATION_RESPONSE_IS_ECC [et_englandwales, et_scotland]: `if(additionalData!=null and additionalData.Data!=null and additionalData.Data.sendNotificationCollection!=null and count(additionalData.Data...`
- initiation helper LATEST_NOTIFICATION_RESPONSE_IS_FROM_CLAIMANT [et_englandwales, et_scotland]: `if(additionalData!=null and additionalData.Data!=null and additionalData.Data.sendNotificationCollection!=null and count(additionalData.Data...`
- initiation helper CURRENT_REFERRAL_SERIAL_NUMBER [et_englandwales, et_scotland]: `if(additionalData!=null and additionalData.Data!=null and additionalData.Data.referralCollection!=null and count(additionalData.Data.referra...`
- initiation helper CURRENT_REFERRAL_SUBJECT [et_englandwales, et_scotland]: `if(additionalData!=null and additionalData.Data!=null and additionalData.Data.referralCollection!=null and count(additionalData.Data.referra...`
- initiation helper CURRENT_REFERRAL_RESPONSE_SERIAL_NUMBER [et_englandwales, et_scotland]: `if(additionalData!=null and additionalData.Data!=null and additionalData.Data.referralCollection!=null and count(additionalData.Data.referra...`
- initiation helper CURRENT_REFERRAL_RESPONSE_SUBJECT [et_englandwales, et_scotland]: `if(additionalData != null and additionalData.Data != null and additionalData.Data.referralCollection != null and count(additionalData.Data.r...`
- initiation helper CURRENT_NOTIFICATION_NAME [et_englandwales, et_scotland]: `if additionalData != null and additionalData.Data != null and additionalData.Data.sendNotificationCollection != null and count(additionalDat...`
- initiation helper LATEST_REFERRAL_TASK_NAME [et_scotland_multiple]: `if(additionalData!=null and additionalData.Data!=null and additionalData.Data.referralCollection!=null and count(additionalData.Data.referra...`
- initiation helper LATEST_REFERRAL_REPLY_NUMBER [et_englandwales_multiple, et_scotland_multiple]: `if(additionalData!=null and additionalData.Data!=null and additionalData.Data.referralCollection!=null and count(additionalData.Data.referra...`
- initiation helper LATEST_REFERRAL_REPLY_SUBJECT [et_englandwales_multiple, et_scotland_multiple]: `if(additionalData!=null and additionalData.Data!=null and additionalData.Data.referralCollection!=null and count(additionalData.Data.referra...`
- initiation helper LATEST_REFERRAL_REPLY_TASK_NAME [et_scotland_multiple]: `if(additionalData!=null and additionalData.Data!=null and additionalData.Data.referralCollection!=null and count(additionalData.Data.referra...`
- initiation helper LATEST_REFERRAL_NUMBER [et_englandwales_multiple]: `if(additionalData!=null and additionalData.Data!=null and additionalData.Data.referralCollection!=null and count(additionalData.Data.referra...`
- initiation helper LATEST_REFERRAL_NUMBER [et_scotland_multiple]: `if(additionalData!=null and additionalData.Data!=null and additionalData.Data.referralCollection!=null and count(additionalData.Data.referra...`
- initiation helper LATEST_REFERRAL_SUBJECT [et_englandwales_multiple]: `if(additionalData!=null and additionalData.Data!=null and additionalData.Data.referralCollection!=null and count(additionalData.Data.referra...`
- initiation helper LATEST_REFERRAL_SUBJECT [et_scotland_multiple]: `if(additionalData!=null and additionalData.Data!=null and additionalData.Data.referralCollection!=null and count(additionalData.Data.referra...`
- configuration output value [et_englandwales, et_scotland]: `if (LATEST_REVIEW_REFERRAL_TASK_TITLE != null) then "EJ - " + LATEST_REVIEW_REFERRAL_TASK_TITLE else if (taskAttributes != null and taskAttr...`
- configuration output value [et_englandwales, et_scotland]: `if (LATEST_REVIEW_REFERRAL_TASK_TITLE != null) then "LO - " + LATEST_REVIEW_REFERRAL_TASK_TITLE else if (taskAttributes != null and taskAttr...`
- configuration output value [et_englandwales, et_scotland]: `if (LATEST_REVIEW_REFERRAL_RESPONSE_TASK_TITLE != null) then "EJ - " + LATEST_REVIEW_REFERRAL_RESPONSE_TASK_TITLE else if (taskAttributes !=...`
- configuration output value [et_englandwales, et_scotland]: `if (LATEST_REVIEW_REFERRAL_RESPONSE_TASK_TITLE != null) then "LO - " + LATEST_REVIEW_REFERRAL_RESPONSE_TASK_TITLE else if (taskAttributes !=...`
- configuration output value [et_englandwales, et_englandwales_multiple, et_scotland, et_scotland_multiple]: `if (caseData != null and caseData.referralCollection != null and count(caseData.referralCollection) > 0 and sort(caseData.referralCollection...`
- configuration output value [et_englandwales, et_englandwales_multiple, et_scotland_multiple]: `if (caseData != null and caseData.referralCollection != null and count(caseData.referralCollection[count(value.referralReplyCollection)>0])>...`
- configuration output value [et_englandwales, et_englandwales_multiple, et_scotland, et_scotland_multiple]: `if (caseData != null and caseData.referralCollection != null and count(caseData.referralCollection) > 0 and sort(caseData.referralCollection...`
- configuration output value [et_englandwales, et_englandwales_multiple, et_scotland, et_scotland_multiple]: `if (caseData!=null and caseData.referralCollection != null and count(caseData.referralCollection[count(value.referralReplyCollection)>0])>0 ...`
- configuration output value [et_englandwales, et_englandwales_multiple, et_scotland, et_scotland_multiple]: `time("16:00")`
- configuration output value [et_englandwales, et_englandwales_multiple, et_scotland, et_scotland_multiple]: `now()`
- configuration output value [et_englandwales, et_scotland]: `if (caseData != null and caseData.hearingDetailsCollection != null and count(caseData.hearingDetailsCollection) = 1) then date and time(case...`
- configuration output value [et_englandwales, et_scotland]: `if month(dueDateOrigin) = 2 then 18 else if month(dueDateOrigin) = 4 or month(dueDateOrigin) = 6 or month(dueDateOrigin) = 9 or month(dueDat...`
- configuration output value [et_englandwales, et_englandwales_multiple, et_scotland, et_scotland_multiple]: `if (caseData != null and caseData.referralCollection != null and count(caseData.referralCollection) > 0 and sort(caseData.referralCollection...`
- configuration output value [et_englandwales, et_englandwales_multiple, et_scotland, et_scotland_multiple]: `if (caseData!=null and caseData.referralCollection != null and count(caseData.referralCollection[count(value.referralReplyCollection)>0])>0 ...`
- configuration output value [et_englandwales, et_scotland]: `if caseData.nextListedDate != null then if (date(caseData.nextListedDate) - today()) <= duration("P10D") then 2001 else if (date(caseData.ne...`
- configuration output value [et_englandwales, et_scotland]: `if caseData.nextListedDate != null then if (date(caseData.nextListedDate) - today()) <= duration("P30D") then 1 else 10 else 10`
- configuration output value [et_englandwales, et_scotland]: `if caseData.nextListedDate != null then if (date(caseData.nextListedDate) - today()) <= duration("P3D") then 100 else 500 else 500`
- configuration output value [et_englandwales, et_scotland]: `if caseData.nextListedDate != null then if (date(caseData.nextListedDate) - today()) <= duration("P3D") then 1000 else 5001 else 5001`
- configuration output value [et_scotland]: `if (caseData!=null and caseData.referralCollection != null and count(caseData.referralCollection[count(value.referralReplyCollection)>0])>0 ...`
- configuration helper reviewReferralSerialNumberAndSubject [et_englandwales, et_scotland]: `{ "__prefix" : "__processCategory__reviewReferralSerialNumberAndSubject_", "__attribute_entries" : get entries(taskAttributes), "__matching_...`
- configuration helper referralReviewResponseSerialNumberAndSubject [et_englandwales, et_scotland]: `{ "__prefix" : "__processCategory__reviewReferralResponseSerialNumberAndSubject_", "__attribute_entries" : get entries(taskAttributes), "__m...`

## Files

| File | Rules | Inputs | Outputs | Helpers |
| --- | ---: | ---: | ---: | ---: |
| wa-task-cancellation-employment-et_englandwales.dmn | 17 | 3 | 4 | 0 |
| wa-task-cancellation-employment-et_englandwales_multiple.dmn | 2 | 3 | 4 | 0 |
| wa-task-cancellation-employment-et_scotland.dmn | 17 | 3 | 4 | 0 |
| wa-task-cancellation-employment-et_scotland_multiple.dmn | 2 | 3 | 4 | 0 |
| wa-task-completion-employment-et_englandwales.dmn | 30 | 1 | 2 | 0 |
| wa-task-completion-employment-et_englandwales_multiple.dmn | 7 | 1 | 2 | 0 |
| wa-task-completion-employment-et_scotland.dmn | 30 | 1 | 2 | 0 |
| wa-task-completion-employment-et_scotland_multiple.dmn | 7 | 1 | 2 | 0 |
| wa-task-configuration-employment-et_englandwales.dmn | 86 | 2 | 3 | 4 |
| wa-task-configuration-employment-et_englandwales_multiple.dmn | 28 | 2 | 3 | 0 |
| wa-task-configuration-employment-et_scotland.dmn | 86 | 2 | 3 | 4 |
| wa-task-configuration-employment-et_scotland_multiple.dmn | 28 | 2 | 3 | 0 |
| wa-task-initiation-employment-et_englandwales.dmn | 59 | 22 | 4 | 13 |
| wa-task-initiation-employment-et_englandwales_multiple.dmn | 6 | 5 | 4 | 6 |
| wa-task-initiation-employment-et_scotland.dmn | 59 | 23 | 4 | 13 |
| wa-task-initiation-employment-et_scotland_multiple.dmn | 6 | 5 | 4 | 6 |
| wa-task-permissions-employment-et_englandwales.dmn | 21 | 2 | 7 | 0 |
| wa-task-permissions-employment-et_englandwales_multiple.dmn | 14 | 2 | 7 | 0 |
| wa-task-permissions-employment-et_scotland.dmn | 21 | 2 | 7 | 0 |
| wa-task-permissions-employment-et_scotland_multiple.dmn | 14 | 2 | 7 | 0 |
| wa-task-types-employment-et_englandwales.dmn | 37 | 1 | 2 | 0 |
| wa-task-types-employment-et_englandwales_multiple.dmn | 6 | 1 | 2 | 0 |
| wa-task-types-employment-et_scotland.dmn | 37 | 1 | 2 | 0 |
| wa-task-types-employment-et_scotland_multiple.dmn | 6 | 1 | 2 | 0 |
