import { SlashCommandBuilder, ChatInputCommandInteraction, MessageFlags } from 'discord.js';

export default {
    data: new SlashCommandBuilder()
        .setName('info')
        .setDescription('Get info about a user or a server!')
        .addSubcommand( (subcommand) => {
            return subcommand
                .setName('user')
                .setDescription('Get info about a user!')
                .addUserOption( (option) => {
                    return option
                        .setName('target')
                        .setDescription('The user')
                })
        })
        .addSubcommand( (subcommand) => {
            return subcommand
                .setName('server')
                .setDescription('Get info about the server!')
        }),
    async execute(interaction: ChatInputCommandInteraction) {
        const subcommand = interaction.options.getSubcommand();

        if (subcommand === 'user') {
            const target = interaction.options.getUser('target') ?? interaction.user;
        
            if (!interaction.inCachedGuild()) {
                await interaction.reply({
                    content: `Username: ${target.username}\nID: ${target.id}`,
                    flags: MessageFlags.Ephemeral,
                });
                return;
            }

            const member = await interaction.guild.members.fetch(target.id).catch(() => null);

            if (!member) {
                await interaction.reply({
					content: `Username: ${target.username}\nID: ${target.id}\n(This user is not currently a member of this server.)`,
                    flags: MessageFlags.Ephemeral,
                });
                return;
            }

            await interaction.reply({
				content: `Username: ${member.user.username}\nID: ${member.id}\nJoined server: ${member.joinedAt}\nAccount created: ${member.user.createdAt}`,
				flags: MessageFlags.Ephemeral,
            });
            return;
        }

        if (subcommand === 'server') {
            if (!interaction.inCachedGuild()) {
                await interaction.reply({
                    content: 'This command can only be used in a server.',
					flags: MessageFlags.Ephemeral,
                });
                return;
            }

            await interaction.reply({
                content: `Server name: ${interaction.guild.name}\nTotal members: ${interaction.guild.memberCount}\nCreated: ${interaction.guild.createdAt}`,
				flags: MessageFlags.Ephemeral,
            });
        }
    },
}