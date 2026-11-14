# Routing baseline m4-baseline

```json
{
 "label": "m4-baseline",
 "commit": "55c1c20",
 "prompts": 40,
 "exactCorrect": 38,
 "expectedGroupRecall": "37/38",
 "promptsMissingAnExpectedGroup": 1,
 "promptsWithAForbiddenGroup": 1,
 "promptsOfferingWrongExternalDataGroup": 1,
 "meanGroupsOffered": 1.77
}
```

## Not exact

| id | prompt | missing | forbidden offered | offered |
|---|---|---|---|---|
| P21 | Open https://example.com and tell me the main heading. | browser |  | personal, web, workshop |
| P40 | Explain how events work in JavaScript. |  | calendar | calendar |
