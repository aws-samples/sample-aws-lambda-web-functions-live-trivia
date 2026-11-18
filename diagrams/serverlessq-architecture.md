# ServerlessQ architecture assets

The application uses browser clients, two AWS Lambda Web Functions, six
regional DynamoDB tables, Cognito administrator authentication, CloudWatch
logs and metrics, and a private S3 deployment bucket.

## Files

- [Editable draw.io source](serverlessq-architecture.drawio)
- [PNG export](serverlessq-architecture.png)
- [SVG export](serverlessq-architecture.svg)

Open the `.drawio` file in diagrams.net to edit it. The PNG is 4913 × 2328,
exported at twice the drawing's scale. The SVG embeds its AWS artwork and has no
external image dependency.

Solid arrows describe runtime interactions; dashed arrows describe code
deployment. The AWS Cloud outline is a visual grouping, not a VPC or private
network boundary. The diagram abstracts HomeRegion and MultiRegion endpoint
selection. Additional serving regions do not replicate the DynamoDB tables.

Administrator authentication uses Cognito access tokens and the `admins`
group. The browser signs in directly with Cognito using SRP; the API retrieves
public signing keys and validates access-token identity before group membership.
The [textual request flows](diagrams.md) describe the same authentication contract.

## Sources and artwork

Component references in the editable source point to retained application
files and Terraform resources. The embedded AWS icons come from the official
AWS Architecture Icons package. Existing artwork and styles are preserved
when changing labels or source references. Cognito uses the certified AWS4
resource icon and security-category gradient.

Relevant sources:

- `packages/web/index.js`
- `packages/web/src/App.tsx`
- `packages/api/src/routers/public.ts`
- `packages/api/src/sse.ts`
- `packages/api/src/middleware/adminAuth.ts`
- `packages/api/src/auth/adminJwt.ts`
- `infra/terraform/cognito.tf`
- `packages/api/src/metrics.ts`
- `packages/shared/src/repositories/ddb.ts`
- `infra/terraform/dynamodb.tf`
- `infra/terraform/s3.tf`
- `scripts/deploy.sh`
