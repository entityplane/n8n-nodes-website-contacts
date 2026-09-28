import type {
	IAuthenticateGeneric,
	ICredentialTestRequest,
	ICredentialType,
	Icon,
	INodeProperties,
} from 'n8n-workflow';

// Same name and shape as the credential in Apify's own n8n node, so a user's existing
// Apify credential works here too.
export class ApifyApi implements ICredentialType {
	name = 'apifyApi';

	displayName = 'Apify API';

	icon: Icon = { light: 'file:../icons/apify.svg', dark: 'file:../icons/apify.svg' };

	documentationUrl = 'https://docs.apify.com/platform/integrations/api#api-token';

	properties: INodeProperties[] = [
		{
			displayName: 'API Key',
			name: 'apiKey',
			type: 'string',
			typeOptions: { password: true },
			default: '',
		},
	];

	authenticate: IAuthenticateGeneric = {
		type: 'generic',
		properties: {
			headers: {
				Authorization: '=Bearer {{$credentials.apiKey}}',
			},
		},
	};

	test: ICredentialTestRequest = {
		request: {
			baseURL: 'https://api.apify.com',
			url: '/v2/users/me',
		},
	};
}
