import { ChannelType, PermissionFlagsBits, type GuildBasedChannel, type Role } from 'discord.js';
import { getRecruitSettings, setRecruitSettings, type RecruitSettings } from '../storage.ts';
import { replyEphemeral } from '../../../core/discord.ts';
import { daysOption, followUpsBlockedNotice, type GuildCommandInteraction, type RecruitSubcommand } from './helpers.ts';

function describeSettings(settings: RecruitSettings): string {
	const ping = settings.ping_role_id ? `pinging <@&${settings.ping_role_id}>` : 'pinging no one';
	return `Follow-ups go to <#${settings.channel_id}>, ${ping}, ${settings.follow_up_days} days after a trial member is added.`;
}

// Warn but still save, as /reminder create does: the permissions can be
// granted after, and refusing would make the moderator redo the command.
// Nothing is known while the bot's member or the channel isn't cached.
function warnings(
	interaction: GuildCommandInteraction,
	channel: GuildBasedChannel | undefined,
	role: Role | undefined,
): string[] {
	const me = interaction.guild.members.me;
	const perms = me && channel ? channel.permissionsFor(me) : null;
	if (!perms) return [];

	const found: string[] = [];
	const missing: string[] = [];
	if (!perms.has(PermissionFlagsBits.ViewChannel)) missing.push('View Channel');
	if (!perms.has(PermissionFlagsBits.SendMessages)) missing.push('Send Messages');
	if (missing.length > 0) {
		found.push(
			`⚠️ I'm missing these permissions in that channel: ${missing.join(', ')}. Follow-ups will pause there until I have them.`,
		);
	}
	// Discord pings a role from a bot only if the role allows anyone to
	// mention it (Discord's allowed mentions docs); the post still goes out,
	// without the ping. Mention Everyone is taken to cover any role, as the
	// role settings say, but that hasn't been tried on a live server.
	if (role && !role.mentionable && !perms.has(PermissionFlagsBits.MentionEveryone)) {
		found.push(
			`⚠️ ${role} doesn't allow anyone to mention it, so follow-ups may not ping it. Turn on "Allow anyone to @mention this role" in its settings, or give me Mention Everyone.`,
		);
	}
	return found;
}

// The bot pings the role on every follow-up, so it must be one the moderator
// could ping themselves: otherwise /recruit, which a server can grant to a
// role under Integrations, would let them ping a role they can't. @everyone
// is refused outright: the role picker offers it, and it isn't a group of
// moderators.
function roleRefusal(
	interaction: GuildCommandInteraction,
	role: Role,
	channel: GuildBasedChannel | undefined,
): string | null {
	if (role.id === interaction.guildId) return "Follow-ups can't ping @everyone. Pick a moderator role.";
	if (role.mentionable) return null;
	const memberPerms = channel?.permissionsFor(interaction.member) ?? interaction.memberPermissions;
	if (memberPerms.has(PermissionFlagsBits.MentionEveryone)) return null;
	return `${role} doesn't allow anyone to mention it, and you can't mention it yourself (Mention Everyone), so I won't ping it for you. Turn on "Allow anyone to @mention this role" in its settings, or ask someone who can mention it.`;
}

export default {
	name: 'config',
	build: (subcommand) =>
		subcommand
			.setDescription('Set where follow-ups are posted, who is pinged, and after how long. No options shows them.')
			.addChannelOption((option) =>
				option
					.setName('channel')
					.setDescription('The channel to post follow-ups in (running this again resumes paused ones)')
					.addChannelTypes(ChannelType.GuildText),
			)
			.addRoleOption((option) => option.setName('role').setDescription('The role to ping with each follow-up'))
			.addBooleanOption((option) => option.setName('no_ping').setDescription('Stop pinging a role'))
			.addIntegerOption(daysOption('days', 'Default days until a follow-up, for trial members added from now on')),
	async execute(interaction) {
		const guildId = interaction.guildId;
		const channel = interaction.options.getChannel('channel', false, [ChannelType.GuildText]) ?? undefined;
		const role = interaction.options.getRole('role') ?? undefined;
		const noPing = interaction.options.getBoolean('no_ping') ?? false;
		const days = interaction.options.getInteger('days') ?? undefined;

		if (role && noPing) {
			await replyEphemeral(interaction, 'Give either a `role` to ping or `no_ping`, not both.');
			return;
		}

		if (!channel && !role && !noPing && days === undefined) {
			const settings = getRecruitSettings(guildId);
			if (!settings) {
				await replyEphemeral(interaction, 'Not set up yet: `/recruit config channel:` picks where follow-ups go.');
				return;
			}
			const blocked = followUpsBlockedNotice(settings);
			await replyEphemeral(interaction, describeSettings(settings) + (blocked ? `\n\n${blocked}` : ''));
			return;
		}

		if (role) {
			const target = channel ?? interaction.guild.channels.cache.get(getRecruitSettings(guildId)?.channel_id ?? '');
			const refusal = roleRefusal(interaction, role, target);
			if (refusal) {
				await replyEphemeral(interaction, refusal);
				return;
			}
		}

		const saved = setRecruitSettings(guildId, {
			...(channel ? { channelId: channel.id } : {}),
			...(role ? { pingRoleId: role.id } : noPing ? { pingRoleId: null } : {}),
			...(days === undefined ? {} : { followUpDays: days }),
		});
		if (!saved) {
			await replyEphemeral(interaction, 'Pick a `channel` for follow-ups first.');
			return;
		}

		// The saved channel, given or not: a role change is checked against it.
		const savedChannel = channel ?? interaction.guild.channels.cache.get(saved.channel_id);
		const savedRole = role ?? (saved.ping_role_id ? interaction.guild.roles.cache.get(saved.ping_role_id) : undefined);
		const found = warnings(interaction, savedChannel, savedRole);
		await replyEphemeral(
			interaction,
			`Saved. ${describeSettings(saved)}` + (found.length ? `\n\n${found.join('\n')}` : ''),
		);
	},
} satisfies RecruitSubcommand;
