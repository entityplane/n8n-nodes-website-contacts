import type { ICredentialType, Icon, INodeProperties } from 'n8n-workflow';

const scopes = ['profile', 'full_api_access'];

// Same name and shape as the credential in Apify's own n8n node: n8n Cloud supplies the OAuth
// app for this credential name, which is why it only works there.
export class ApifyOAuth2Api implements ICredentialType {
	name = 'apifyOAuth2Api';

	extends = ['oAuth2Api'];

	displayName = 'Apify OAuth2 API';

	icon: Icon = { light: 'file:../icons/apify.svg', dark: 'file:../icons/apify.svg' };

	documentationUrl = 'https://docs.apify.com/platform/integrations/n8n';

	properties: INodeProperties[] = [
		{
			displayName: 'Grant Type',
			name: 'grantType',
			type: 'hidden',
			default: 'pkce',
		},
		{
			displayName: 'Authorization URL',
			name: 'authUrl',
			type: 'hidden',
			default: 'https://console.apify.com/authorize/oauth',
		},
		{
			displayName: 'Access Token URL',
			name: 'accessTokenUrl',
			type: 'hidden',
			default: 'https://console-backend.apify.com/oauth/apps/token',
		},
		{
			displayName: 'Scope (do not change)',
			name: 'scope',
			type: 'string',
			default: scopes.join(' '),
			noDataExpression: true,
			displayOptions: {
				hideOnCloud: true,
			},
		},
		{
			displayName: 'Auth URI Query Parameters',
			name: 'authQueryParameters',
			type: 'hidden',
			default: '',
		},
		{
			displayName: 'Authentication',
			name: 'authentication',
			type: 'hidden',
			default: 'header',
		},
		{
			displayName: 'Client ID',
			name: 'clientId',
			type: 'hidden',
			default: '',
		},
		{
			displayName: 'Client Secret',
			name: 'clientSecret',
			type: 'hidden',
			default: '',
			typeOptions: { password: true },
		},
		{
			displayName:
				'This credential type is not available on self-hosted n8n instances, please use an API key instead.',
			name: 'notice',
			type: 'notice',
			default: '',
			displayOptions: {
				hideOnCloud: true,
			},
		},
	];
}
